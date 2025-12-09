import { ponder } from "ponder:registry";
import { position } from "ponder:schema";

/**
 * Supply event handler
 * - If position doesn't exist: create new position
 * - If position exists: add to suppliedShares
 */
ponder.on("Spoke:Supply", async ({ event, context }) => {
  const proxyAddress = event.args.user;
  const suppliedShares = event.args.suppliedShares;
  const timestamp = event.block.timestamp;

  await context.db
    .insert(position)
    .values({
      proxyAddress,
      suppliedShares,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate((row) => ({
      suppliedShares: row.suppliedShares + suppliedShares,
      updatedAt: timestamp,
    }));
});

/**
 * Withdraw event handler
 * - Subtract withdrawnShares from position
 */
ponder.on("Spoke:Withdraw", async ({ event, context }) => {
  const proxyAddress = event.args.user;
  const withdrawnShares = event.args.withdrawnShares;
  const timestamp = event.block.timestamp;

  // Update position - subtract withdrawn shares
  // Note: If this results in 0 shares, position stays but with 0 shares
  // The API will filter out positions with 0 collateral anyway
  await context.db
    .update(position, { proxyAddress })
    .set((row) => ({
      suppliedShares: row.suppliedShares - withdrawnShares,
      updatedAt: timestamp,
    }));
});

/**
 * LiquidationCall event handler
 * - Full liquidation: delete position
 */
ponder.on("Spoke:LiquidationCall", async ({ event, context }) => {
  const proxyAddress = event.args.user;

  // Full liquidation - remove position
  await context.db.delete(position, { proxyAddress });
});
