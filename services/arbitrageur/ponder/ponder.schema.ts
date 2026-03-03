import { onchainTable } from "ponder";

/**
 * Tracks vaults currently held in escrow (available for arbitrageurs to acquire).
 * - Added on AddedVault event (vault escrowed during liquidation)
 * - Removed on RemovedVault event (vault acquired or emergency repaid)
 */
export const escrowedVault = onchainTable("escrowed_vault", (t) => ({
  // Vault ID is the unique identifier (bytes32)
  vaultId: t.hex().primaryKey(),
  // Timestamp when vault was escrowed
  createdAt: t.bigint().notNull(),
}));
