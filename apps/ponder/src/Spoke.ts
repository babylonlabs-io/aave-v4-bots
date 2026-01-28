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
 * - Skip if position doesn't exist (e.g. START_BLOCK is after the Supply event)
 */
ponder.on("Spoke:Withdraw", async ({ event, context }) => {
  const proxyAddress = event.args.user;
  const withdrawnShares = event.args.withdrawnShares;
  const timestamp = event.block.timestamp;

  const existingRecord = await context.db.find(position, { proxyAddress });
  if (!existingRecord) return;

  const newShares = existingRecord.suppliedShares - withdrawnShares;

  if (newShares <= 0n) {
    await context.db.delete(position, { proxyAddress });
  } else {
    await context.db.update(position, { proxyAddress }).set({
      suppliedShares: newShares,
      updatedAt: timestamp,
    });
  }
});

/**
 * LiquidationCall event handler
 * - Full liquidation: delete position
 * - Skip if position doesn't exist (e.g. START_BLOCK is after the Supply event)
 */
ponder.on("Spoke:LiquidationCall", async ({ event, context }) => {
  const proxyAddress = event.args.user;

  const existingRecord = await context.db.find(position, { proxyAddress });
  if (!existingRecord) return;

  await context.db.delete(position, { proxyAddress });
});
