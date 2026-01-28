import { ponder } from "ponder:registry";
import { vault } from "ponder:schema";

/**
 * VaultOwnershipTransferred event handler
 * - Upsert vault row tracking current and previous owner
 * - Covers: liquidation, escrow for swap, release from swap, emergency repay
 */
ponder.on("Controller:VaultOwnershipTransferred", async ({ event, context }) => {
  const vaultId = event.args.vaultId;
  const previousOwner = event.args.previousOwner;
  const newOwner = event.args.newOwner;
  const timestamp = event.block.timestamp;

  await context.db
    .insert(vault)
    .values({
      vaultId,
      owner: newOwner,
      previousOwner,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate(() => ({
      owner: newOwner,
      previousOwner,
      updatedAt: timestamp,
    }));
});
