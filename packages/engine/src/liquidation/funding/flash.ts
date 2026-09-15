import { liquidationRouterAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import { minWbtcProfitFloor, probeLiquidation, quoteProfit } from "./flashProbe";
import type {
  FlashFundingParams,
  FundedCandidate,
  FundingContext,
  LiquidationCandidate,
  LiquidationFunding,
} from "./types";
import { allFundableTokens, assertRegistryValid, buildFlashDatas } from "./venues";

/**
 * Repay from flash liquidity, through `LiquidationRouter`.
 *
 * The router borrows each debt token from a venue, liquidates, and repays the venues out of the
 * seized WBTC — so the signer needs no inventory, grants no approvals, and spends only gas. What it
 * costs instead is a probe per candidate: `liquidate` with a sentinel `minWbtcProfit` runs the whole
 * liquidation and reverts with `BelovedError`, which is the only way to learn the realised WBTC and
 * the exact venue debts.
 *
 * The venue selection that keeps every venue debt WBTC-denominated — and therefore `swapDatas`
 * empty — lives in `./venues`.
 */
/** Flash funding touches none of the adapter/inventory half of the context. */
export type FlashFundingDeps = Pick<
  FundingContext,
  "publicClient" | "wbtcAddress" | "executor" | "logger" | "metrics" | "risk"
> &
  Omit<FlashFundingParams, "mode">;

export class FlashFunding implements LiquidationFunding {
  readonly mode = "flash" as const;

  constructor(private readonly deps: FlashFundingDeps) {
    // Fail at construction, not on the first liquidatable position: a mis-paired pool or a
    // duplicated token would otherwise surface as a revert deep inside a venue callback, hours
    // later, on the one candidate that mattered.
    assertRegistryValid(deps.venues);
  }

  /** Nothing to approve — the router grants the adapter its own allowance, from its own balance. */
  async prepare(): Promise<void> {}

  /** Nothing to publish — no action declares a `spend`, so the gate needs no balances from us. */
  async refreshInventory(): Promise<void> {}

  /** Nothing to withdraw: the router borrows and repays itself, so this mode grants no allowance. */
  async revokeApprovals(): Promise<void> {}

  /**
   * Viable iff the probe returns a quote that clears zero profit.
   *
   * The probe is not merely a price check: it runs the whole liquidation, so reaching a quote at
   * all proves the venues have the liquidity, the pool keys resolve, and the position is still
   * liquidatable. That is why it replaces the inventory simulation rather than joining it.
   */
  async vet(candidates: readonly LiquidationCandidate[]): Promise<FundedCandidate[]> {
    const { venues, routerAddress, maxSlippageBps, wbtcAddress, logger, metrics, risk } = this.deps;
    // The operator's absolute floor rides along on-chain, so an action the gate admitted on the
    // quote cannot settle below it (see `minWbtcProfitFloor`).
    const minProfit = risk.minProfit();

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

    const probed = await Promise.allSettled(
      candidates.map(async (candidate) => {
        // From the venue registry, never from the Lens indexing: the two disagree about what the
        // amounts array is indexed by. The router skips whatever owes nothing.
        const flashDatas = buildFlashDatas(
          allFundableTokens(venues),
          candidate.wbtcPayment,
          venues
        );

        const result = await probeLiquidation({
          publicClient: this.deps.publicClient,
          router: routerAddress,
          owner: this.deps.executor.identity.from,
          borrower: candidate.position.borrower,
          flashDatas,
        });

        if (result.kind === "unavailable") return { skip: result.reason };

        const quote = quoteProfit(result, wbtcAddress, routerWbtcBefore);
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
}
