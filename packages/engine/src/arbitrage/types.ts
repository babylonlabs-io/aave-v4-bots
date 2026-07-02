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
}
