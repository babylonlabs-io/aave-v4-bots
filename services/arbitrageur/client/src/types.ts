import type { Hex } from "viem";

/**
 * Escrowed vault returned from Ponder API
 */
export interface EscrowedVault {
  vaultId: Hex;
  amountVault: string;
  amountDebt: string;
  amountFee: string;
  
  amountWbtcToAcquire: string;
  isProfitable: boolean;
}

/**
 * Response from Ponder /escrowed-vaults endpoint
 */
export interface PonderResponse {
  vaults: EscrowedVault[];
  total: number;
}
