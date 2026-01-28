import { ponder } from "ponder:registry";
import { ownedVault } from "ponder:schema";

/**
 * VaultClaimableBy event handler
 * - Vault has been redeemed by its owner
 * - Remove vault from owned_vault table
 */
ponder.on("BTCVaultsManager:VaultClaimableBy", async ({ event, context }) => {
  const vaultId = event.args.vaultId;

  // Remove from owned vaults (vault has been redeemed)
  await context.db.delete(ownedVault, { vaultId });
});
