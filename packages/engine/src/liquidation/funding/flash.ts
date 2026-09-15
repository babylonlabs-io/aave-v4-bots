import { type FlashData, type VenueDebt, liquidationRouterAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import type { Address } from "viem";
import type { SpokeReserves } from "../reserves";
import { minWbtcProfitFloor, probeLiquidation, quoteProfit } from "./flashProbe";
import type {
  FlashFundingParams,
  FundedCandidate,
  FundingContext,
  LiquidationCandidate,
  LiquidationFunding,
} from "./types";
import { type ReadCache, createReadCache } from "./venueRoutes/cache";
import { quoteDivergences } from "./venueRoutes/divergence";
import { type VenueSources, createVenueSources } from "./venueRoutes/factory";
import { buildRankedFlashDatas } from "./venueRoutes/flashDatas";
import { sizeOwedLegs } from "./venueRoutes/legs";
import { planRoute } from "./venueRoutes/planner";
import type { OwedLeg, PlannedLeg, QuoteOutcome, VenueSource } from "./venueRoutes/types";
import {
  type VenueRegistry,
  allFundableTokens,
  assertRegistryValid,
  buildFlashDatas,
} from "./venues";

/**
 * Repay from flash liquidity, through `LiquidationRouter`.
 *
 * The router borrows each debt token from a venue, liquidates, and repays the venues out of the
 * seized WBTC — so the signer needs no inventory, grants no approvals, and spends only gas. What it
 * costs instead is a probe per candidate: `liquidate` with a sentinel `minWbtcProfit` runs the whole
 * liquidation and reverts with `BelovedError`, which is the only way to learn the realised WBTC and
 * the exact venue debts.
 *
 * Venues come one of two ways. A fixed registry names one venue per token, and `./venues` builds
 * the route from it. With ranking, several venues per token are quoted for each candidate and the
 * cheapest that fills each token is routed (`./venueRoutes`). Either way every venue debt is
 * WBTC-denominated, so `swapDatas` stays empty.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Flash funding touches none of the adapter/inventory half of the context. */
export type FlashFundingDeps = Pick<
  FundingContext,
  "publicClient" | "wbtcAddress" | "executor" | "logger" | "metrics" | "risk" | "reserves"
> &
  DistributiveOmit<FlashFundingParams, "mode">;

/** A candidate's route: the entries to send, and — when ranked — the legs they were chosen for. */
type Route = { flashDatas: FlashData[]; legs: readonly PlannedLeg[] } | { skip: string };

export class FlashFunding implements LiquidationFunding {
  readonly mode = "flash" as const;
  /** Present exactly when venues are fixed. */
  private readonly venues?: VenueRegistry;
  /** Present exactly when venues are ranked. */
  private readonly sources?: VenueSources;
  /** This cycle's read cache. Every `vet` starts a fresh one. */
  private cache: ReadCache = createReadCache();

  constructor(private readonly deps: FlashFundingDeps) {
    // Fail at construction, not on the first liquidatable position: a mis-paired pool or a
    // duplicated token would otherwise surface as a revert deep inside a venue callback, hours
    // later, on the one candidate that mattered.
    if (deps.ranking === undefined) {
      assertRegistryValid(deps.venues);
      this.venues = deps.venues;
    } else {
      this.sources = createVenueSources(deps.ranking.entries, {
        publicClient: deps.publicClient,
        wbtc: deps.wbtcAddress,
        cache: () => this.cache,
        quoter: deps.ranking.quoter,
        stateView: deps.ranking.stateView,
      });
    }
  }

  /**
   * Nothing to approve — the router grants the adapter its own allowance, from its own balance.
   * With ranking, checks that the configured venues agree with each other; that only reads.
   */
  async prepare(): Promise<void> {
    await this.sources?.prepare();
  }

  /** Nothing to publish — no action declares a `spend`, so the gate needs no balances from us. */
  async refreshInventory(): Promise<void> {}

  /** Nothing to withdraw: the router borrows and repays itself, so this mode grants no allowance. */
  async revokeApprovals(): Promise<void> {}

  /**
   * Viable iff the probe returns a quote that clears zero profit.
   *
   * The probe is not merely a price check: it runs the whole liquidation, so reaching a quote at
   * all proves the venues have the liquidity, the pool keys resolve, and the position is still
   * liquidatable. That is why it replaces the inventory simulation rather than joining it — and why
   * ranking only chooses the route it probes, never replaces it.
   */
  async vet(candidates: readonly LiquidationCandidate[]): Promise<FundedCandidate[]> {
    const { routerAddress, maxSlippageBps, wbtcAddress, logger, metrics, risk } = this.deps;
    // The operator's absolute floor rides along on-chain, so an action the gate admitted on the
    // quote cannot settle below it (see `minWbtcProfitFloor`).
    const minProfit = risk.minProfit();
    this.cache = createReadCache();

    // WBTC already sitting in the router, subtracted from every probe below: `netWbtcBeforePayment`
    // is a raw `balanceOf`, so anything the router already held would be booked as profit we did not
    // earn. Normally zero — the router sweeps itself empty — but nothing stops someone transferring
    // tokens to it.
    //
    // A failed read skips the whole cycle rather than assuming zero. Assuming zero is not the
    // conservative guess it looks like: it *inflates* every quote in this pass by whatever the router
    // actually holds, so the gate can admit a liquidation on profit that is not there. One skipped
    // poll costs a cycle; a wrong baseline costs a liquidation.
    let routerWbtcBefore: bigint;
    try {
      routerWbtcBefore = await readBalance(this.deps.publicClient, wbtcAddress, routerAddress);
    } catch (error) {
      metrics.recordError("router_balance_read_error");
      logger.error(
        `Could not read the router's WBTC balance; skipping this cycle rather than quoting against an unknown baseline: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }

    // Ranking sizes each candidate's legs by reserve id, so it needs the reserve list as it is this
    // cycle. A failed read is left to fail the cycle: without it no candidate can be sized.
    const topology = this.sources === undefined ? undefined : await this.deps.reserves();

    const probed = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const route = await this.route(candidate, topology);
        if ("skip" in route) return { skip: route.skip };
        const { flashDatas, legs } = route;

        const result = await probeLiquidation({
          publicClient: this.deps.publicClient,
          router: routerAddress,
          owner: this.deps.executor.identity.from,
          borrower: candidate.position.borrower,
          flashDatas,
        });

        if (result.kind === "unavailable") return { skip: result.reason };

        const quote = quoteProfit(result, wbtcAddress, routerWbtcBefore);
        this.reportDivergences(candidate, legs, result.debts);
        if (quote.expectedProfit <= 0n) {
          return { skip: `unprofitable (${quote.expectedProfit} sats)` };
        }

        const call: ContractCall = {
          // The router recomputes the amounts itself, so it takes the borrower rather than the
          // repay vector. `swapDatas` is empty: every venue debt is WBTC-denominated, which is the
          // whole point of the venue selection.
          address: routerAddress,
          abi: liquidationRouterAbi,
          functionName: "liquidate",
          args: [
            {
              borrower: candidate.position.borrower,
              minWbtcProfit: minWbtcProfitFloor(quote.expectedProfit, maxSlippageBps, minProfit),
            },
            [...flashDatas],
            [],
          ],
        };

        return {
          funded: {
            ...candidate,
            call,
            // No `spend`: the router funds itself and sweeps the proceeds back, so reserving the
            // signer's inventory would block the arbitrage engine for balances this tx never
            // touches. And the probe *does* price the action, so the gate's profit floor becomes
            // usable for liquidations for the first time.
            risk: { expectedProfit: quote.expectedProfit },
          } satisfies FundedCandidate,
        };
      })
    );

    const viable: FundedCandidate[] = [];
    for (let i = 0; i < probed.length; i++) {
      const outcome = probed[i];
      const candidate = candidates[i];

      if (outcome.status === "rejected") {
        // A throw is a malfunction (RPC down, a flashDatas that broke an invariant), not a verdict
        // on the candidate — `unavailable` is how the probe says "not this one".
        metrics.recordError("flash_probe_error");
        const reason = outcome.reason;
        logger.error(
          `Flash probe failed for ${candidate.position.proxyAddress}: ${reason instanceof Error ? reason.message : String(reason)}`
        );
        continue;
      }

      if ("skip" in outcome.value) {
        metrics.recordSimulationFailed();
        logger.warn(
          `Flash probe skipped ${candidate.position.proxyAddress}: ${outcome.value.skip}`
        );
        continue;
      }

      viable.push(outcome.value.funded);
    }
    return viable;
  }

  private async route(
    candidate: LiquidationCandidate,
    topology: SpokeReserves | undefined
  ): Promise<Route> {
    if (this.sources !== undefined && topology !== undefined) {
      return this.rankedRoute(candidate, topology, this.sources);
    }
    const venues = this.venues as VenueRegistry;
    // From the venue registry, never from the Lens indexing: the two disagree about what the
    // amounts array is indexed by. The router skips whatever owes nothing.
    return {
      flashDatas: buildFlashDatas(allFundableTokens(venues), candidate.wbtcPayment, venues),
      legs: [],
    };
  }

  /** Quotes every venue for each token the candidate owes, and routes each through the cheapest. */
  private async rankedRoute(
    candidate: LiquidationCandidate,
    topology: SpokeReserves,
    sources: VenueSources
  ): Promise<Route> {
    const { wbtcAddress, logger, metrics } = this.deps;
    const proxy = candidate.position.proxyAddress;

    const sized = sizeOwedLegs(candidate, topology, wbtcAddress);
    if (sized.kind === "skip") return { skip: sized.reason };

    const outcomesByToken = new Map<Address, readonly QuoteOutcome[]>();
    await Promise.all(
      sized.legs.map(async (leg) => {
        const venues = sources.byToken.get(leg.token) ?? [];
        outcomesByToken.set(leg.token, await Promise.all(venues.map((s) => this.quote(s, leg))));
      })
    );

    const plan = planRoute(sized.legs, outcomesByToken);
    if (plan.kind === "unfundable") {
      return {
        skip: `no venue can fund it: ${plan.tokens
          .map(({ token, reasons }) => `${token} (${reasons.join("; ")})`)
          .join(", ")}`,
      };
    }

    if (plan.degraded.length > 0) {
      // For these tokens no venue gave a usable quote, and at least one could not answer at all. A
      // failed quote is an outage, not a verdict, so the route uses the first venue that could not
      // answer, in configuration order, and the probe decides.
      metrics.recordError("venue_quote_degraded");
      logger.warn(
        `No usable venue quote for ${plan.degraded.join(", ")} on ${proxy}, and at least one quote failed; routing through the first venue that could not be quoted`
      );
    }
    logger.debug(
      `Route for ${proxy}: ${plan.legs
        .map(
          (leg) =>
            `${leg.token} via ${leg.source.id} ${leg.quotedWbtcRepay === undefined ? "(unquoted)" : `for ${leg.quotedWbtcRepay} WBTC at ${leg.costBps} bps`}`
        )
        .join("; ")}`
    );

    return {
      flashDatas: buildRankedFlashDatas(plan.legs, sources.byToken, wbtcAddress),
      legs: plan.legs,
    };
  }

  /**
   * One source's quote for one leg. Memoised for the cycle, so candidates asking a venue about the
   * same size share one quote.
   */
  private async quote(source: VenueSource, leg: OwedLeg): Promise<QuoteOutcome> {
    try {
      const quote = await this.cache.get(`quote:${source.id}:${leg.amount}`, () =>
        source.quote(leg.token, leg.amount)
      );
      return { status: "quoted", source, quote };
    } catch (error) {
      return { status: "unknown", source, error };
    }
  }

  private reportDivergences(
    candidate: LiquidationCandidate,
    legs: readonly PlannedLeg[],
    debts: readonly VenueDebt[]
  ): void {
    for (const { venue, quotedWbtc, probedWbtc } of quoteDivergences(legs, debts)) {
      this.deps.metrics.recordError("venue_quote_divergence");
      this.deps.logger.warn(
        `The probe for ${candidate.position.proxyAddress} owes venue ${venue} ${probedWbtc} WBTC against a quote of ${quotedWbtc}; venue ranking is choosing from stale or wrong quotes`
      );
    }
  }
}
