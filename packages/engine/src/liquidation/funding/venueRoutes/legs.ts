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
 * The debt is resolved to a token through the reserve at its id, never by position, for the same
 * reason as everywhere else a preview amount is read: the preview names the reserve by id.
 *
 * A WBTC debt and the fairness payment share one leg: the router borrows WBTC once for both.
 *
 * The non-WBTC leg comes first, WBTC last, the order `flashDatas` uses.
 *
 * @throws when the candidate names a reserve id the topology does not have — the two were read
 *         against different Spokes, and nothing sized from them can be trusted. Also on a negative
 *         figure: a real preview produces none, so it means the candidate was built wrong.
 */
export function sizeOwedLegs(
  candidate: Pick<LiquidationCandidate, "debtReserveId" | "debtToCover" | "fairnessPayment">,
  topology: SpokeReserves,
  wbtc: Address
): OwedLegs {
  const { debtReserveId: id, debtToCover, fairnessPayment } = candidate;
  if (fairnessPayment < 0n) {
    throw new Error(`fairness payment must not be negative, got ${fairnessPayment}`);
  }
  if (debtToCover < 0n) {
    throw new Error(`amount for reserve id ${id} must not be negative, got ${debtToCover}`);
  }

  const reserve = topology.reserves[Number(id)];
  if (reserve === undefined || BigInt(reserve.id) !== id) {
    throw new Error(
      `reserve id ${id} is not among the Spoke's ${topology.reserves.length} reserves`
    );
  }
  const wbtcKey = getAddress(wbtc);
  const token = getAddress(reserve.token);

  const legs: OwedLeg[] = [];
  let wbtcAmount = fairnessPayment;
  if (token === wbtcKey) wbtcAmount += debtToCover;
  else if (debtToCover > 0n) legs.push({ token, amount: debtToCover });
  if (wbtcAmount > 0n) legs.push({ token: wbtcKey, amount: wbtcAmount });

  if (legs.length === 0) {
    return { kind: "skip", reason: "nothing to flash-borrow: no debt and no fairness payment" };
  }
  return { kind: "sized", legs };
}
