import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import type { Address, PublicClient } from "viem";

import { vaultSwapAbi } from "../../abis/VaultSwap";

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => String(x));
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
 * Uses a single batch call to getEscrowedVaultsInfo for efficiency.
 * This is the main endpoint the arbitrageur client will poll.
 */
app.get("/escrowed-vaults", async (c) => {
  const publicClient = Object.values(publicClients)[0] as PublicClient | undefined;

  if (!publicClient) {
    return c.json({ error: "No public client configured" }, 500);
  }

  const vaultSwapAddress = process.env.VAULT_SWAP_ADDRESS as Address;
  if (!vaultSwapAddress) {
    return c.json({ error: "VAULT_SWAP_ADDRESS not configured" }, 500);
  }

  // Query all escrowed vaults from database
  const vaults = await db.query.escrowedVault.findMany();

  if (vaults.length === 0) {
    return c.json({ vaults: [], total: 0, failedVaultsCount: 0 });
  }

  // Build vault ID array and createdAt lookup
  const vaultIds = vaults.map((v) => v.vaultId);
  const createdAtMap = new Map(vaults.map((v) => [v.vaultId, v.createdAt]));
  const toApiVault = (info: {
    vaultId: `0x${string}`;
    btcAmount: bigint;
    hubDebt: bigint;
    protocolFee: bigint;
  }) => ({
    vaultId: info.vaultId,
    btcAmount: info.btcAmount.toString(),
    currentDebt: (info.hubDebt + info.protocolFee).toString(),
    createdAt: createdAtMap.get(info.vaultId)?.toString() ?? "0",
  });

  try {
    // Single batch RPC call to get info for all vaults
    const vaultsInfo = await publicClient.readContract({
      address: vaultSwapAddress,
      abi: vaultSwapAbi,
      functionName: "getEscrowedVaultsInfo",
      args: [vaultIds],
    });

    const enrichedVaults = vaultsInfo.map(toApiVault);

    return c.json(
      replaceBigInts({
        vaults: enrichedVaults,
        total: enrichedVaults.length,
        failedVaultsCount: 0,
      })
    );
  } catch (error) {
    console.error("Batch getEscrowedVaultsInfo failed, falling back to per-vault fetch:", error);

    const settled = await Promise.allSettled(
      vaultIds.map((vaultId) =>
        publicClient.readContract({
          address: vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "getEscrowedVaultsInfo",
          args: [[vaultId]],
        })
      )
    );

    const enrichedVaults = [];
    let failed = 0;

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const vaultId = vaultIds[i];
      if (result.status === "fulfilled" && result.value.length > 0) {
        enrichedVaults.push(toApiVault(result.value[0]));
      } else {
        failed += 1;
        console.error(
          `Failed to fetch vault info for ${vaultId}:`,
          result.status === "rejected" ? result.reason : "empty response"
        );
      }
    }

    return c.json(
      replaceBigInts({
        vaults: enrichedVaults,
        total: enrichedVaults.length,
        failedVaultsCount: failed,
      }),
      enrichedVaults.length > 0 ? 200 : 500
    );
  }
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
        createdAt: v.createdAt,
      })),
      total: vaults.length,
    })
  );
});

export default app;
