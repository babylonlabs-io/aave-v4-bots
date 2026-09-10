// Pure liquidation-domain logic (no IO).

/**
 * Inflate one Lens-estimated amount by `bufferBps` (default 1%), rounding up.
 *
 * The Lens returns an exact figure for the block it read; interest accrues between that read and
 * execution, so a small buffer avoids `MustNotLeaveDust` reverts on the debt amounts and
 * `ExcessiveWbtcPayment` on the payment cap (a single mined block of growth is enough on
 * auto-mining chains).
 *
 * Rounded up so that every nonzero amount is buffered by at least one unit. Truncating instead
 * leaves any amount below `10_000 / bufferBps` exactly where it was, and every value this produces
 * is a cap the adapter enforces: on a fairness payment of 99 sats that means an upward oracle tick
 * of a single sat between simulate and mine reverts the liquidation, and the revert is charged to
 * the breaker. Over-buffering by a unit costs nothing — the adapter refunds unconsumed debt cover
 * and charges the recomputed payment, never the cap. Zero stays zero.
 */
export function bufferAmount(amount: bigint, bufferBps = 100): bigint {
  return (amount * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
}

/** `bufferAmount` over a whole estimate. */
export function bufferAmounts(amounts: readonly bigint[], bufferBps = 100): bigint[] {
  return amounts.map((amt) => bufferAmount(amt, bufferBps));
}

/**
 * Aave Spoke `ReserveFlags` bitmap.
 * See lib/tbv-contracts/lib/aave-v4/src/spoke/libraries/ReserveFlagsMap.sol.
 */
export const RESERVE_FLAG = {
  PAUSED: 0x01,
  FROZEN: 0x02,
  BORROWABLE: 0x04,
} as const;

/** Whether a reserve's flags mark it borrowable (a debt token to consider). */
export function isBorrowableReserve(flags: number): boolean {
  return (flags & RESERVE_FLAG.BORROWABLE) !== 0;
}

/** Most liquidation candidates one cycle takes from the indexer. The rest wait for later cycles. */
export const MAX_LIQUIDATION_CANDIDATES = 500;

/** Lens estimates run this many at a time, so a long candidate list cannot flood the RPC. */
export const LENS_ESTIMATE_CHUNK = 25;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The positions one cycle acts on: the first entry for each proxy (case-insensitive), in feed
 * order, capped at `max`. The feed is cast, not parsed, so this runs before any RPC call and drops
 * entries without a usable `proxyAddress`.
 */
export function selectPositions<P extends { proxyAddress: string }>(
  positions: readonly P[],
  max = MAX_LIQUIDATION_CANDIDATES
): { positions: P[]; malformed: number; duplicates: number; truncated: number } {
  const seen = new Set<string>();
  const unique: P[] = [];
  let malformed = 0;
  for (const p of positions) {
    const proxy = (p as { proxyAddress?: unknown } | null)?.proxyAddress;
    if (typeof proxy !== "string" || !ADDRESS.test(proxy)) {
      malformed++;
      continue;
    }
    const k = proxy.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }
  return {
    positions: unique.slice(0, max),
    malformed,
    duplicates: positions.length - malformed - unique.length,
    truncated: Math.max(0, unique.length - max),
  };
}
