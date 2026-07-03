import { onchainTable } from "ponder";

// Union of the liquidation and arbitrage schemas. Tables for a disabled mode
// simply stay empty; their API endpoints return empty results.

// ── liquidation ──────────────────────────────────────────────────────────────

/**
 * Tracks proxy addresses that have collateral positions.
 * - Added on Supply event
 * - Updated on Withdraw (shares decremented)
 * - Updated on LiquidationCall (partial liquidation decrements shares)
 * - Removed when shares reach 0
 */
export const position = onchainTable("position", (t) => ({
  proxyAddress: t.hex().primaryKey(),
  suppliedShares: t.bigint().notNull().default(0n),
  createdAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/**
 * Maps proxy addresses to borrower (EOA) addresses.
 * - Populated from UserProxyCreated events on AaveAdapter
 * - Used to resolve borrower address for liquidate / liquidateWithLLP calls
 */
export const proxyMapping = onchainTable("proxy_mapping", (t) => ({
  proxyAddress: t.hex().primaryKey(),
  borrower: t.hex().notNull(),
  createdAt: t.bigint().notNull(),
}));

// ── arbitrage ────────────────────────────────────────────────────────────────

/**
 * Tracks vaults currently held in escrow (available for arbitrageurs to acquire).
 * - Added on AddedVault event (vault escrowed during liquidation)
 * - Removed on RemovedVault event (vault acquired or emergency repaid)
 */
export const escrowedVault = onchainTable("escrowed_vault", (t) => ({
  vaultId: t.hex().primaryKey(),
  createdAt: t.bigint().notNull(),
}));
