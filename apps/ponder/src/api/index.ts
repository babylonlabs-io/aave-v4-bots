import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import type { Address, PublicClient } from "viem";

import { spokeAbi } from "../../abis/Spoke";

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => `${String(x)}n`);
}

const app = new Hono();

// GraphQL endpoint
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

// SQL client endpoint
app.use("/sql/*", client({ db, schema }));

// Health factor threshold (1.0 in WAD = 1e18)
const HEALTH_FACTOR_THRESHOLD = BigInt(1e18);

/**
 * GET /liquidatable-positions
 *
 * Returns all positions that are liquidatable (health factor < 1.0 AND has debt)
 *
 * Uses multicall to batch all getUserAccountData calls into a single RPC request
 */
app.get("/liquidatable-positions", async (c) => {
  // Get the public client for the network
  const publicClient = Object.values(publicClients)[0] as PublicClient | undefined;

  if (!publicClient) {
    return c.json({ error: "No public client configured" }, 500);
  }

  // Get spoke address from env
  const spokeAddress = process.env.SPOKE_ADDRESS as Address;
  if (!spokeAddress) {
    return c.json({ error: "SPOKE_ADDRESS not configured" }, 500);
  }

  // Query all positions from database
  const positions = await db.query.position.findMany();

  if (positions.length === 0) {
    return c.json({ liquidatable: [], total: 0, checked: 0 });
  }

  // Fetch account data for all positions in parallel
  const results = await Promise.allSettled(
    positions.map((p) =>
      publicClient.readContract({
        address: spokeAddress,
        abi: spokeAbi,
        functionName: "getUserAccountData",
        args: [p.proxyAddress],
      })
    )
  );

  const liquidatable: Array<{
    proxyAddress: string;
    healthFactor: string;
    totalCollateralValue: string;
    totalDebtValue: string;
    suppliedShares: string;
  }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const p = positions[i];

    if (result.status === "rejected") {
      console.error(`Failed to fetch account data for ${p.proxyAddress}:`, result.reason);
      continue;
    }

    const accountData = result.value;
    const healthFactor = accountData.healthFactor;
    const totalDebtValue = accountData.totalDebtValue;

    // Liquidatable if: health factor < 1.0 AND has debt
    if (healthFactor < HEALTH_FACTOR_THRESHOLD && totalDebtValue > 0n) {
      liquidatable.push({
        proxyAddress: p.proxyAddress,
        healthFactor: healthFactor.toString(),
        totalCollateralValue: accountData.totalCollateralValue.toString(),
        totalDebtValue: totalDebtValue.toString(),
        suppliedShares: p.suppliedShares.toString(),
      });
    }
  }

  return c.json(
    replaceBigInts({
      liquidatable,
      total: liquidatable.length,
      checked: positions.length,
    })
  );
});

/**
 * GET /positions
 *
 * Returns all tracked positions (for debugging)
 */
app.get("/positions", async (c) => {
  const positions = await db.query.position.findMany();

  return c.json(
    replaceBigInts({
      positions: positions.map((p) => ({
        proxyAddress: p.proxyAddress,
        suppliedShares: p.suppliedShares,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      total: positions.length,
    })
  );
});

/**
 * GET /positions-health
 *
 * Returns all positions with their health factors (for debugging)
 */
app.get("/positions-health", async (c) => {
  const publicClient = Object.values(publicClients)[0] as PublicClient | undefined;

  if (!publicClient) {
    return c.json({ error: "No public client configured" }, 500);
  }

  const spokeAddress = process.env.SPOKE_ADDRESS as Address;
  if (!spokeAddress) {
    return c.json({ error: "SPOKE_ADDRESS not configured" }, 500);
  }

  const positions = await db.query.position.findMany();

  if (positions.length === 0) {
    return c.json({ positions: [], total: 0 });
  }

  // Fetch account data for all positions in parallel
  const accountDataCalls = [];
  for (const p of positions) {
    accountDataCalls.push(
      publicClient.readContract({
        address: spokeAddress,
        abi: spokeAbi,
        functionName: "getUserAccountData",
        args: [p.proxyAddress],
      })
    );
  }
  const results = await Promise.allSettled(accountDataCalls);

  const positionsWithHealth = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const p = positions[i];

    if (result.status === "rejected") {
      positionsWithHealth.push({
        proxyAddress: p.proxyAddress,
        error: "Failed to fetch account data",
        errorDetails: result.reason instanceof Error ? result.reason.message : "Unknown error",
      });
      continue;
    }

    const accountData = result.value;
    const healthFactorWad = accountData.healthFactor;
    const healthFactorFormatted = Number(healthFactorWad) / 1e18;

    positionsWithHealth.push({
      proxyAddress: p.proxyAddress,
      healthFactor: healthFactorWad.toString(),
      healthFactorFormatted,
      totalCollateralValue: accountData.totalCollateralValue.toString(),
      totalDebtValue: accountData.totalDebtValue.toString(),
      isLiquidatable: healthFactorWad < HEALTH_FACTOR_THRESHOLD && accountData.totalDebtValue > 0n,
      threshold: HEALTH_FACTOR_THRESHOLD.toString(),
    });
  }

  return c.json(
    replaceBigInts({
      positions: positionsWithHealth,
      total: positions.length,
    })
  );
});

/**
 * GET /owned-vaults?owner=0x...
 *
 * Returns all vaults owned by the given address
 */
app.get("/owned-vaults", async (c) => {
  const owner = c.req.query("owner");

  if (!owner) {
    return c.json({ error: "Missing required query parameter: owner" }, 400);
  }

  const ownerLower = owner.toLowerCase() as `0x${string}`;

  const vaults = await db.query.vault.findMany({
    where: (fields, { eq }) => eq(fields.owner, ownerLower),
  });

  return c.json(
    replaceBigInts({
      vaults: vaults.map((v) => ({
        vaultId: v.vaultId,
        owner: v.owner,
        previousOwner: v.previousOwner,
        updatedAt: v.updatedAt,
      })),
      total: vaults.length,
    })
  );
});

export default app;
