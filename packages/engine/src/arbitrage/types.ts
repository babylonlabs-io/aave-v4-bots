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
   * at — fed to the risk gate's freshness guard. Optional: an older indexer omits it, in which
   * case the guard simply does not apply.
   */
  dataTimestampMs?: number;
}
