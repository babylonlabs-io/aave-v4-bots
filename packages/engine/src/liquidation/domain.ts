// Pure liquidation-domain logic (no IO).

/**
 * Inflate one Lens-estimated amount by `bufferBps` (default 1%).
 *
 * The Lens returns an exact figure for the block it read; interest accrues between that read and
 * execution, so a small buffer avoids `MustNotLeaveDust` reverts on the debt amounts and
 * `ExcessiveWbtcPayment` on the payment cap (a single mined block of growth is enough on
 * auto-mining chains).
 */
export function bufferAmount(amount: bigint, bufferBps = 100): bigint {
  return (amount * BigInt(10_000 + bufferBps)) / 10_000n;
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
