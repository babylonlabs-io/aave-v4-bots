import type { Address, Hex } from "viem";

/**
 * Escrowed vault returned from Ponder API
 */
export interface EscrowedVault {
  vaultId: Hex;
  seller: Address;
  btcAmount: string;
  currentDebt: string;
  createdAt: string;
}

/**
 * Response from Ponder /escrowed-vaults endpoint
 */
export interface PonderResponse {
  vaults: EscrowedVault[];
  total: number;
}

/**
 * Vault owned by the arbitrageur (tracked locally)
 */
export interface OwnedVault {
  vaultId: Hex;
  acquiredAt: number; // timestamp
  wbtcPaid: bigint;
  btcAmount: bigint;
}
