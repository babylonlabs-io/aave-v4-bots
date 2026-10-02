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
 * One leg per token, carrying the sum over every reserve that lists it: reserves can share an
 * underlying, and the router borrows once per token for the summed debt and approves the adapter
 * once for the same sum. A leg per reserve would quote each venue at part of the size the router
 * actually draws.
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

  const amountsByToken = new Map<Address, bigint>();
  let wbtcAmount = wbtcPayment;

  for (const { id, amount } of debts) {
    const reserve = topology.reserves[Number(id)];
    if (reserve === undefined || BigInt(reserve.id) !== id) {
      throw new Error(
        `reserve id ${id} is not among the Spoke's ${topology.reserves.length} reserves`
      );
    }
    const token = getAddress(reserve.token);

    if (token === wbtcKey) wbtcAmount += amount;
    else amountsByToken.set(token, (amountsByToken.get(token) ?? 0n) + amount);
  }

  const legs: OwedLeg[] = [...amountsByToken].map(([token, amount]) => ({ token, amount }));
  if (wbtcAmount > 0n) legs.push({ token: wbtcKey, amount: wbtcAmount });

  if (legs.length === 0) {
    return { kind: "skip", reason: "nothing to flash-borrow: no debt and no fairness payment" };
  }
  return { kind: "sized", legs };
}
