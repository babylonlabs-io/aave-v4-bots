import type { VenueDebt } from "@repo/abis";
import { type Address, getAddress } from "viem";
import type { PlannedLeg } from "./types";

export interface QuoteDivergence {
  venue: Address;
  quotedWbtc: bigint;
  probedWbtc: bigint;
}

/**
 * The venues the probe found dearer than their quotes said.
 *
 * Compared per venue address, summed, because that is the finest grain the probe reports: a debt
 * names the contract that lent, and every UniswapV4 pool is reached through one swap venue, so two
 * pools on it share an address. A venue with an unquoted (degraded) leg is left out, since that leg
 * has no quote to compare.
 *
 * Quotes are sized at the engine's buffered amounts, above what the router borrows, so a probe that
 * comes back higher means the venue got dearer between the quote and the probe, or the quote was
 * wrong. It changes nothing about this liquidation — the probe has already priced it — but it is
 * the signal that the ranking is working from bad numbers.
 */
export function quoteDivergences(
  legs: readonly PlannedLeg[],
  debts: readonly VenueDebt[]
): QuoteDivergence[] {
  const quoted = new Map<Address, bigint | undefined>();
  for (const leg of legs) {
    const venue = getAddress(leg.source.flashData().venueAddress);
    const sum = quoted.has(venue) ? quoted.get(venue) : 0n;
    quoted.set(
      venue,
      sum === undefined || leg.quotedWbtcRepay === undefined ? undefined : sum + leg.quotedWbtcRepay
    );
  }

  const probed = new Map<Address, bigint>();
  for (const debt of debts) {
    const venue = getAddress(debt.venue);
    probed.set(venue, (probed.get(venue) ?? 0n) + debt.amount);
  }

  const divergences: QuoteDivergence[] = [];
  for (const [venue, quotedWbtc] of quoted) {
    if (quotedWbtc === undefined) continue;
    const probedWbtc = probed.get(venue) ?? 0n;
    if (probedWbtc > quotedWbtc) divergences.push({ venue, quotedWbtc, probedWbtc });
  }
  return divergences;
}
