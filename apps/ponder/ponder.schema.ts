import { onchainTable } from "ponder";

/**
 * Tracks proxy addresses that have collateral positions.
 * - Added on Supply event
 * - Updated on Withdraw (shares decremented)
 * - Removed when shares = 0 or on LiquidationCall
 */
export const position = onchainTable("position", (t) => ({
  // Proxy address is the unique identifier
  proxyAddress: t.hex().primaryKey(),
  // Track supplied shares to know when position is closed
  suppliedShares: t.bigint().notNull().default(0n),
  // Timestamp of first supply (position creation)
  createdAt: t.bigint().notNull(),
  // Timestamp of last update
  updatedAt: t.bigint().notNull(),
}));

/**
 * Tracks vault ownership via VaultOwnershipTransferred events from Controller.
 * - Upserted on every ownership transfer (liquidation, escrow, release, emergency repay)
 */
export const vault = onchainTable("vault", (t) => ({
  vaultId: t.hex().primaryKey(),
  owner: t.hex().notNull(),
  previousOwner: t.hex().notNull(),
  updatedAt: t.bigint().notNull(),
}));
