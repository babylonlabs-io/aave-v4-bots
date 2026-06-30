import { ponder } from "ponder:registry";
import { escrowedVault } from "ponder:schema";
import { INDEX_ARBITRAGE } from "./flags";

// Registered only when arbitrage indexing is enabled, so `ponder.on("VaultSwap:…")`
// is never called for a contract the config didn't include.
if (INDEX_ARBITRAGE) {
  /**
   * AddedVault event handler
   * - Vault has been escrowed during liquidation (available for arbitrageurs)
   * - Add vault to escrowed_vault table
   */
  ponder.on("VaultSwap:AddedVault", async ({ event, context }) => {
    const vaultId = event.args.vaultId;
    const timestamp = event.block.timestamp;

    await context.db
      .insert(escrowedVault)
      .values({
        vaultId,
        createdAt: timestamp,
      })
      .onConflictDoNothing();
  });

  /**
   * RemovedVault event handler
   * - Vault has been acquired by arbitrageur or emergency repaid
   * - Remove vault from escrowed_vault table
   */
  ponder.on("VaultSwap:RemovedVault", async ({ event, context }) => {
    const vaultId = event.args.vaultId;

    await context.db.delete(escrowedVault, { vaultId });
  });
}
