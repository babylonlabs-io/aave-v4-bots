import { type Address, getAddress } from "viem";
import type { SpokeReserves } from "../../reserves";
import type { LiquidationCandidate } from "../types";
import type { OwedLeg } from "./types";

export type OwedLegs = { kind: "sized"; legs: OwedLeg[] } | { kind: "skip"; reason: string };

/**
 * The tokens a candidate needs flash-borrowed, and roughly how much of each.
 *
 * Approximate on purpose. The amounts carry the engine's accrual buffer, and the router ignores them
 * regardless: it re-reads the liquidation preview at execution and borrows what that says. These are
 * sizes to quote venues at — close enough to rank them — and the probe is what checks the chosen
 * route against the real figures.
 *
 * Amounts are resolved to tokens through the reserve at each paired id, never by position, for the
 * same reason as everywhere else a preview amount is read: the preview pairs amounts with ids.
 *
 * Non-WBTC legs come first in reserve-id order, WBTC last, the order `flashDatas` uses.
 *
 * @throws when the candidate names a reserve id the topology does not have — the two were read
 *         against different Spokes, and nothing sized from them can be trusted. Also on ids and
 *         amounts that do not pair one-to-one, a repeated id, or a negative figure: a real preview
 *         produces none of these, so each means the candidate was built wrong.
 */
export function sizeOwedLegs(
  candidate: Pick<LiquidationCandidate, "debtReserveIds" | "debtToCoverAmounts" | "wbtcPayment">,
  topology: SpokeReserves,
  wbtc: Address
): OwedLegs {
  const { debtReserveIds, debtToCoverAmounts, wbtcPayment } = candidate;
  if (debtReserveIds.length !== debtToCoverAmounts.length) {
    throw new Error(
      `candidate pairs ${debtReserveIds.length} reserve ids with ${debtToCoverAmounts.length} amounts`
    );
  }

  const reserveIdsByToken = new Map<string, number[]>();
  for (const reserve of topology.reserves) {
    const key = getAddress(reserve.token);
    reserveIdsByToken.set(key, [...(reserveIdsByToken.get(key) ?? []), reserve.id]);
  }

  if (wbtcPayment < 0n) {
    throw new Error(`fairness payment must not be negative, got ${wbtcPayment}`);
  }
  const seenIds = new Set<bigint>();
  for (let i = 0; i < debtReserveIds.length; i++) {
    const id = debtReserveIds[i];
    // The router spreads the pairs into one slot per reserve, so a repeated id keeps only one of its
    // amounts there. Summing them here would size a borrow the router never makes.
    if (seenIds.has(id)) throw new Error(`reserve id ${id} appears twice in the candidate`);
    seenIds.add(id);
    if (debtToCoverAmounts[i] < 0n) {
      throw new Error(
        `amount for reserve id ${id} must not be negative, got ${debtToCoverAmounts[i]}`
      );
    }
  }

  const wbtcKey = getAddress(wbtc);
  const debts = debtReserveIds
    .map((id, i) => ({ id, amount: debtToCoverAmounts[i] }))
    .filter((d) => d.amount > 0n)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const legs: OwedLeg[] = [];
  let wbtcAmount = wbtcPayment;

  for (const { id, amount } of debts) {
    const reserve = topology.reserves[Number(id)];
    if (reserve === undefined || BigInt(reserve.id) !== id) {
      throw new Error(
        `reserve id ${id} is not among the Spoke's ${topology.reserves.length} reserves`
      );
    }
    const token = getAddress(reserve.token);

    // The router sizes a borrow by looking the token up among the reserves and taking the *first*
    // match, but hands the adapter every reserve's debt. A token listed under two ids is therefore
    // under-borrowed whenever the debt is not all on the first one — including debt sitting only on
    // the later id, where the first match reads zero. No quote describes what the router would
    // borrow, so the candidate cannot be flash-funded as priced.
    const sharing = reserveIdsByToken.get(token) ?? [];
    if (sharing.length > 1) {
      return {
        kind: "skip",
        reason: `owes ${token}, which reserves ${sharing.join(", ")} share; the router borrows only the first reserve's debt for a token`,
      };
    }

    if (token === wbtcKey) wbtcAmount += amount;
    else legs.push({ token, amount });
  }

  if (wbtcAmount > 0n) legs.push({ token: wbtcKey, amount: wbtcAmount });

  if (legs.length === 0) {
    return { kind: "skip", reason: "nothing to flash-borrow: no debt and no fairness payment" };
  }
  return { kind: "sized", legs };
}
