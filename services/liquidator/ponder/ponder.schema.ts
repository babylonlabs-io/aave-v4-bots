import { onchainTable } from "ponder";

/**
 * Tracks proxy addresses that have collateral positions.
 * - Added on Supply event
 * - Updated on Withdraw (shares decremented)
 * - Updated on LiquidationCall (partial liquidation decrements shares)
 * - Removed when shares reach 0
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
 * Maps proxy addresses to borrower (EOA) addresses.
 * - Populated from UserProxyCreated events on Controller
 * - Used to resolve borrower address for liquidateCorePosition calls
 */
export const proxyMapping = onchainTable("proxy_mapping", (t) => ({
  proxyAddress: t.hex().primaryKey(),
  borrower: t.hex().notNull(),
  createdAt: t.bigint().notNull(),
}));
