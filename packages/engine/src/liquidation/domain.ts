// Pure liquidation-domain logic (no IO).

/**
 * Inflate each reserve's Lens-estimated repay amount by `bufferBps` (default 1%).
 *
 * The Lens returns exact debt; interest accrues between the read and execution, so
 * a small buffer avoids `MustNotLeaveDust` reverts (a single mined block of growth
 * is enough on auto-mining chains).
 */
export function bufferAmounts(amounts: readonly bigint[], bufferBps = 100): bigint[] {
  const numerator = BigInt(10_000 + bufferBps);
  return amounts.map((amt) => (amt * numerator) / 10_000n);
}

/** Default sequential reserve priority order `[0, 1, …, length-1]`. */
export function sequentialPriorityOrder(length: number): bigint[] {
  return Array.from({ length }, (_, i) => BigInt(i));
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
