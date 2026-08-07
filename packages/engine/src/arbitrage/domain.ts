// Pure arbitrage-domain logic (no IO).

/**
 * Max WBTC the arbitrageur will pay for a vault: the current Hub debt plus a
 * `slippageBps` buffer over it (protects against interest accrual between the
 * preview read and execution).
 */
export function maxWbtcInWithSlippage(currentDebt: bigint, slippageBps: number): bigint {
  const buffer = (currentDebt * BigInt(slippageBps)) / 10_000n;
  return currentDebt + buffer;
}
