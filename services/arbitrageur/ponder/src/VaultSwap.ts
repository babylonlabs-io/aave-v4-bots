import { ponder } from "ponder:registry";
import { escrowedVault, ownedVault } from "ponder:schema";

/**
 * VaultSwappedForWbtc event handler
 * - Seller has escrowed their vault and received WBTC
 * - Add vault to escrowed_vault table (available for arbitrageurs)
 */
ponder.on("VaultSwap:VaultSwappedForWbtc", async ({ event, context }) => {
  const seller = event.args.seller;
  const vaultId = event.args.vaultId;
  const btcAmount = event.args.wbtcAmount; // wbtcAmount equals btcAmount (principal)
  const timestamp = event.block.timestamp;

  await context.db.insert(escrowedVault).values({
    vaultId,
    seller,
    btcAmount,
    createdAt: timestamp,
  });
});

/**
 * WbtcSwappedForVault event handler
 * - Buyer (arbitrageur) has acquired the vault from escrow
 * - Remove vault from escrowed_vault table
 * - Add vault to owned_vault table (tracking arbitrageur ownership)
 */
ponder.on("VaultSwap:WbtcSwappedForVault", async ({ event, context }) => {
  const buyer = event.args.buyer;
  const vaultId = event.args.vaultId;
  const wbtcPaid = event.args.wbtcAmount;
  const timestamp = event.block.timestamp;

  // Get the btcAmount from the escrowed vault before deleting
  const escrowed = await context.db.find(escrowedVault, { vaultId });
  const btcAmount = escrowed?.btcAmount ?? 0n;

  // Remove from escrowed vaults
  await context.db.delete(escrowedVault, { vaultId });

  // Add to owned vaults (tracking arbitrageur ownership until redemption)
  await context.db.insert(ownedVault).values({
    vaultId,
    owner: buyer,
    btcAmount,
    wbtcPaid,
    acquiredAt: timestamp,
  });
});

/**
 * VaultEmergencyRepaid event handler
 * - Admin has emergency repaid a stuck vault
 * - Remove vault from escrowed_vault table
 */
ponder.on("VaultSwap:VaultEmergencyRepaid", async ({ event, context }) => {
  const vaultId = event.args.vaultId;

  await context.db.delete(escrowedVault, { vaultId });
});
