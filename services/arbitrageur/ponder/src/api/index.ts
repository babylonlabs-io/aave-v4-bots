import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import type { Address } from "viem";

import { vaultSwapAbi } from "../../abis/VaultSwap";

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => `${String(x)}n`);
}

const app = new Hono();

// GraphQL endpoint
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

// SQL client endpoint
app.use("/sql/*", client({ db, schema }));

/**
 * GET /escrowed-vaults
 *
 * Returns all escrowed vaults with live debt data from VaultSwap contract.
 * This is the main endpoint the arbitrageur client will poll.
 */
app.get("/escrowed-vaults", async (c) => {
  // Get the public client for the network
  const publicClient = Object.values(publicClients)[0];

  if (!publicClient) {
    return c.json({ error: "No public client configured" }, 500);
  }

  // Get VaultSwap address from env
  const vaultSwapAddress = process.env.VAULT_SWAP_ADDRESS as Address;
  if (!vaultSwapAddress) {
    return c.json({ error: "VAULT_SWAP_ADDRESS not configured" }, 500);
  }

  // Query all escrowed vaults from database
  const vaults = await db.query.escrowedVault.findMany();

  if (vaults.length === 0) {
    return c.json({ vaults: [], total: 0 });
  }

  // Enrich with live debt data from contract
  const enrichedVaults: Array<{
    vaultId: string;
    seller: string;
    btcAmount: string;
    currentDebt: string;
    createdAt: string;
  }> = [];

  for (const vault of vaults) {
    try {
      // Get current debt (principal + accrued interest)
      const currentDebt = await publicClient.readContract({
        address: vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "previewWbtcToAcquireVault",
        args: [vault.vaultId],
      });

      enrichedVaults.push({
        vaultId: vault.vaultId,
        seller: vault.seller,
        btcAmount: vault.btcAmount.toString(),
        currentDebt: currentDebt.toString(),
        createdAt: vault.createdAt.toString(),
      });
    } catch (error) {
      // If we can't get debt, vault might have been removed - skip it
      console.error(`Failed to fetch debt for vault ${vault.vaultId}:`, error);
    }
  }

  return c.json(
    replaceBigInts({
      vaults: enrichedVaults,
      total: enrichedVaults.length,
    })
  );
});

/**
 * GET /escrowed-vaults-raw
 *
 * Returns all indexed escrowed vaults without live enrichment (for debugging)
 */
app.get("/escrowed-vaults-raw", async (c) => {
  const vaults = await db.query.escrowedVault.findMany();

  return c.json(
    replaceBigInts({
      vaults: vaults.map((v) => ({
        vaultId: v.vaultId,
        seller: v.seller,
        btcAmount: v.btcAmount,
        createdAt: v.createdAt,
      })),
      total: vaults.length,
    })
  );
});

/**
 * GET /owned-vaults
 *
 * Returns all vaults owned by arbitrageurs (acquired but not yet redeemed).
 * Optionally filter by owner address using ?owner=0x... query parameter.
 */
app.get("/owned-vaults", async (c) => {
  const ownerFilter = c.req.query("owner")?.toLowerCase();

  let vaults = await db.query.ownedVault.findMany();

  // Filter by owner if provided
  if (ownerFilter) {
    vaults = vaults.filter((v) => v.owner.toLowerCase() === ownerFilter);
  }

  return c.json(
    replaceBigInts({
      vaults: vaults.map((v) => ({
        vaultId: v.vaultId,
        owner: v.owner,
        btcAmount: v.btcAmount.toString(),
        wbtcPaid: v.wbtcPaid.toString(),
        acquiredAt: v.acquiredAt.toString(),
      })),
      total: vaults.length,
    })
  );
});

export default app;
