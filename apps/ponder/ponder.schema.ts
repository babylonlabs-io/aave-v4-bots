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

