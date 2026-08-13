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
   * Positions the indexer could not probe this cycle — a batch that failed as a whole.
   *
   * The candidate list is only as complete as this is zero. Without it a partial scan and a quiet
   * market are the same response, and "no candidates" is the one answer a liquidator must not infer
   * from a failure. Optional for wire compatibility: an indexer too old to report it is treated as
   * having scanned everything, which is what it did before batching existed.
   */
  unscanned?: number;
  /**
   * Chain-block timestamp (ms) the indexer's live `estimateLiquidation` reads were evaluated
   * at — fed to the risk gate's freshness guard.
   *
   * Optional for **wire compatibility only**, not for behavior: the guard is fail-closed, so when
   * `RISK_MAX_DATA_STALENESS_MS` is set an omitted timestamp blocks every liquidation with
   * "missing source timestamp" (and counts a `risk_blocked` error). That is the safe direction —
   * never trade on data of unknown age — but it means pointing a current bot at an indexer too
   * old to send this field silently stops trading. Upgrade the indexer, or leave the staleness
   * bound unset.
   */
  dataTimestampMs?: number;
}
