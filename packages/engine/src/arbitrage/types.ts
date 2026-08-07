import type { Hex } from "viem";

/** Escrowed vault returned from the Ponder API. */
export interface EscrowedVault {
  vaultId: Hex;
  btcAmount: string;
  currentDebt: string;
  createdAt: string;
}

/** Response from the Ponder /escrowed-vaults endpoint. */
export interface PonderResponse {
  vaults: EscrowedVault[];
  total: number;
  /**
   * Chain-block timestamp (ms) the indexer's live `previewEscrowedVaults` read was evaluated
   * at — fed to the risk gate's freshness guard.
   *
   * Optional for **wire compatibility only**, not for behavior: the guard is fail-closed, so when
   * `RISK_MAX_DATA_STALENESS_MS` is set an omitted timestamp blocks every acquisition with
   * "missing source timestamp" (and counts a `risk_blocked` error). That is the safe direction —
   * never trade on data of unknown age — but it means pointing a current bot at an indexer too
   * old to send this field silently stops trading. Upgrade the indexer, or leave the staleness
   * bound unset.
   */
  dataTimestampMs?: number;
}
