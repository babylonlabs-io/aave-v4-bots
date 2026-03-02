import { ponder } from "ponder:registry";
import { proxyMapping, vault } from "ponder:schema";

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

/**
 * UserProxyCreated event handler
 * - Maps proxy address to borrower (EOA) address
 * - Used to resolve borrower for liquidateCorePosition calls
 */
ponder.on("Controller:UserProxyCreated", async ({ event, context }) => {
  const borrower = event.args.user;
  const proxyAddress = event.args.proxy;
  const timestamp = event.block.timestamp;

  await context.db
    .insert(proxyMapping)
    .values({
      proxyAddress,
      borrower,
      createdAt: timestamp,
    })
    .onConflictDoNothing();
});
