import type { Address } from "viem";

export interface LiquidatablePosition {
  proxyAddress: Address;
  borrower: Address;
  amounts: string[];
  vaults: string[];
  suppliedShares: string;
}

export interface PonderResponse {
  liquidatable: LiquidatablePosition[];
  total: number;
  checked: number;
  /**
   * Chain-block timestamp (ms) the indexer's live `estimateLiquidation` reads were evaluated
   * at — fed to the risk gate's freshness guard. Optional: an older indexer omits it, in which
   * case the guard simply does not apply.
   */
  dataTimestampMs?: number;
}
