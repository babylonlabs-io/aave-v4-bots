import { onchainTable } from "ponder";

/**
 * Tracks vaults currently held in escrow (available for arbitrageurs to buy).
 * - Added on VaultSwappedForWbtc event (seller escrows vault)
 * - Removed on WbtcSwappedForVault event (buyer acquires vault)
 * - Removed on VaultEmergencyRepaid event (admin removes stuck vault)
 */
export const escrowedVault = onchainTable("escrowed_vault", (t) => ({
  // Vault ID is the unique identifier (bytes32)
  vaultId: t.hex().primaryKey(),
  // Seller address who escrowed the vault
  seller: t.hex().notNull(),
  // Original BTC amount in the vault (in satoshis)
  btcAmount: t.bigint().notNull(),
  // Timestamp when vault was escrowed
  createdAt: t.bigint().notNull(),
}));

/**
 * Tracks vaults owned by arbitrageurs (acquired but not yet redeemed).
 * - Added on WbtcSwappedForVault event (buyer acquires vault from escrow)
 * - Removed on VaultClaimableBy event from BTCVaultsManager (vault redeemed)
 */
export const ownedVault = onchainTable("owned_vault", (t) => ({
  // Vault ID is the unique identifier (bytes32)
  vaultId: t.hex().primaryKey(),
  // Owner address who acquired the vault
  owner: t.hex().notNull(),
  // BTC amount in the vault (in satoshis)
  btcAmount: t.bigint().notNull(),
  // WBTC paid to acquire the vault (in satoshis)
  wbtcPaid: t.bigint().notNull(),
  // Timestamp when vault was acquired
  acquiredAt: t.bigint().notNull(),
}));
