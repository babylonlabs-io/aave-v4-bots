// Pure arbitrage-domain logic (no IO).

/**
 * Max WBTC the arbitrageur will pay for a vault: the current Hub debt plus a
 * `slippageBps` buffer over it (protects against interest accrual between the
 * preview read and execution).
 *
 * The bound is checked here as well as at config load, because this number *is* the ceiling the
 * signer authorizes. Above 10000 bps it stops being a tolerance and becomes a multiplier — 20000
 * turns a 1 WBTC preview into a 3 WBTC ceiling — and nothing downstream reads as wrong: the payment
 * is simply authorized against a bound nobody intended. `minWbtcProfitFloor` guards its own bps the
 * same way, for the same reason.
 */
export function maxWbtcInWithSlippage(currentDebt: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer in [0, 10000], got ${slippageBps}`);
  }
  const buffer = (currentDebt * BigInt(slippageBps)) / 10_000n;
  return currentDebt + buffer;
}
