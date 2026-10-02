import { type Address, getAddress } from "viem";
import { VenueSelectionError } from "../venues";
import type {
  OwedLeg,
  PlannedLeg,
  QuoteOutcome,
  RoutePlan,
  TokenPlan,
  UnfundableToken,
  VenueSource,
} from "./types";

/**
 * Picks the venue for each token a liquidation owes. Pure: quoting happens before it, the probe after.
 *
 * Each token is decided on its own, and the per-token minimum stands for the whole route: the router
 * takes one entry per token, and each token's sources are different pools or lenders. That ignores
 * gas and any interaction between two swaps in one transaction. The probe runs the combined route,
 * so neither can slip through to a send.
 */

/** Configuration order, then id — a total order, so the same inputs always pick the same source. */
export function byPriority(a: VenueSource, b: VenueSource): number {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const compareBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The cheapest source that can fill `owed`, or why none can.
 *
 * - A source that answered and can fill the size competes on `repayWbtc`, ties broken by priority.
 * - If none can, but some could not answer, the first of those by priority is used anyway. A quoter
 *   outage must not stop liquidations the probe could fund — the probe still runs the route, and
 *   the on-chain floor still binds.
 * - If every source answered and none can fill the size, the token is unfundable.
 *
 * @throws VenueSelectionError (I1) when no source is configured for the token at all — a
 *         configuration gap, not a verdict on this candidate.
 */
export function planToken(owed: OwedLeg, outcomes: readonly QuoteOutcome[]): TokenPlan {
  const token = getAddress(owed.token);
  if (owed.amount <= 0n) {
    throw new Error(`owed amount for ${token} must be positive, got ${owed.amount}`);
  }
  if (outcomes.length === 0) {
    throw new VenueSelectionError("I1", `no venue configured for ${token}`);
  }

  const ids = new Set<string>();
  for (const { source } of outcomes) {
    if (getAddress(source.token) !== token) {
      throw new Error(`venue ${source.id} lends ${getAddress(source.token)}, not ${token}`);
    }
    if (ids.has(source.id)) throw new Error(`duplicate venue id ${source.id}`);
    ids.add(source.id);
  }

  const usable: { source: VenueSource; repayWbtc: bigint; costBps: bigint }[] = [];
  const unanswered: VenueSource[] = [];
  const reasons: string[] = [];

  for (const outcome of outcomes) {
    const { source } = outcome;
    if (outcome.status === "unknown") {
      const { error } = outcome;
      unanswered.push(source);
      reasons.push(
        `${source.id}: quote failed (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }
    const { quote } = outcome;
    if (!quote.available) {
      reasons.push(`${source.id}: ${quote.reason}`);
      continue;
    }
    // Checked even on an available quote: a source that reports its liquidity has made a second
    // claim, and the smaller of the two is the one to believe.
    if (quote.liquidity !== undefined && quote.liquidity < owed.amount) {
      reasons.push(`${source.id}: liquidity ${quote.liquidity} is below ${owed.amount}`);
      continue;
    }
    usable.push({ source, repayWbtc: quote.repayWbtc, costBps: quote.costBps });
  }

  const alternativesTo = (chosen: VenueSource) => outcomes.filter((o) => o.source !== chosen);

  if (usable.length > 0) {
    const [best] = usable.sort(
      (a, b) => compareBigint(a.repayWbtc, b.repayWbtc) || byPriority(a.source, b.source)
    );
    return {
      kind: "ranked",
      leg: {
        token,
        amount: owed.amount,
        source: best.source,
        quotedWbtcRepay: best.repayWbtc,
        costBps: best.costBps,
        alternatives: alternativesTo(best.source),
      },
    };
  }

  if (unanswered.length > 0) {
    const [fallback] = unanswered.sort(byPriority);
    return {
      kind: "degraded",
      leg: { token, amount: owed.amount, source: fallback, alternatives: alternativesTo(fallback) },
    };
  }

  return { kind: "unfundable", token, reasons };
}

/**
 * Plans every owed token. One unfundable token makes the whole candidate unfundable — the router
 * cannot liquidate with a debt left unborrowed — but every token is still planned, so the reasons
 * name all of them rather than the first.
 *
 * @param outcomesByToken Each token's quote outcomes. Keys are compared checksummed.
 * @throws VenueSelectionError (I2) on a token owed twice, or keyed twice.
 */
export function planRoute(
  owed: readonly OwedLeg[],
  outcomesByToken: ReadonlyMap<Address, readonly QuoteOutcome[]>
): RoutePlan {
  const byToken = new Map<string, readonly QuoteOutcome[]>();
  for (const [token, outcomes] of outcomesByToken) {
    const key = getAddress(token);
    if (byToken.has(key)) throw new VenueSelectionError("I2", `quotes for ${key} are keyed twice`);
    byToken.set(key, outcomes);
  }

  const seen = new Set<string>();
  const legs: PlannedLeg[] = [];
  const degraded: Address[] = [];
  const unfundable: UnfundableToken[] = [];

  for (const leg of owed) {
    const key = getAddress(leg.token);
    // The router looks the borrow amount up by token, so one token planned twice would borrow its
    // whole debt twice.
    if (seen.has(key)) throw new VenueSelectionError("I2", `token ${key} is owed twice`);
    seen.add(key);

    const plan = planToken(leg, byToken.get(key) ?? []);
    if (plan.kind === "unfundable") {
      unfundable.push({ token: plan.token, reasons: plan.reasons });
      continue;
    }
    if (plan.kind === "degraded") degraded.push(plan.leg.token);
    legs.push(plan.leg);
  }

  return unfundable.length > 0
    ? { kind: "unfundable", tokens: unfundable }
    : { kind: "funded", legs, degraded };
}
