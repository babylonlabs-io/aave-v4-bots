export function applySupply(currentShares: bigint | null, suppliedShares: bigint): bigint {
  return (currentShares ?? 0n) + suppliedShares;
}

export function applyWithdraw(
  currentShares: bigint | null,
  withdrawnShares: bigint
): bigint | null {
  if (currentShares === null) return null;
  const nextShares = currentShares - withdrawnShares;
  return nextShares <= 0n ? null : nextShares;
}

export function applyLiquidation(
  currentShares: bigint | null,
  collateralSharesToLiquidate: bigint
): bigint | null {
  if (currentShares === null) return null;
  const nextShares = currentShares - collateralSharesToLiquidate;
  return nextShares <= 0n ? null : nextShares;
}
