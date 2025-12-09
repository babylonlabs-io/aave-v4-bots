import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { type Address } from "viem";

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
  const publicClient = Object.values(publicClients)[0];

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

  // Fetch account data for each position (individual calls - works on any chain)
  const liquidatable: Array<{
    proxyAddress: string;
    healthFactor: string;
    totalCollateralValue: string;
    totalDebtValue: string;
    suppliedShares: string;
  }> = [];

  for (const p of positions) {
    try {
      const accountData = await publicClient.readContract({
        address: spokeAddress,
        abi: spokeAbi,
        functionName: "getUserAccountData",
        args: [p.proxyAddress],
      });

      const healthFactor = accountData.healthFactor;
      const totalDebtValue = accountData.totalDebtValue;

      // Liquidatable if: health factor < 1.0 AND has debt
      const isLiquidatable =
        healthFactor < HEALTH_FACTOR_THRESHOLD && totalDebtValue > 0n;

      if (isLiquidatable) {
        liquidatable.push({
          proxyAddress: p.proxyAddress,
          healthFactor: healthFactor.toString(),
          totalCollateralValue: accountData.totalCollateralValue.toString(),
          totalDebtValue: totalDebtValue.toString(),
          suppliedShares: p.suppliedShares.toString(),
        });
      }
    } catch (error) {
      // Skip positions that fail to fetch
      console.error(`Failed to fetch account data for ${p.proxyAddress}:`, error);
    }
  }

  return c.json(replaceBigInts({
    liquidatable,
    total: liquidatable.length,
    checked: positions.length,
  }));
});

/**
 * GET /positions
 *
 * Returns all tracked positions (for debugging)
 */
app.get("/positions", async (c) => {
  const positions = await db.query.position.findMany();

  return c.json(replaceBigInts({
    positions: positions.map((p) => ({
      proxyAddress: p.proxyAddress,
      suppliedShares: p.suppliedShares,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    total: positions.length,
  }));
});

/**
 * GET /positions-health
 *
 * Returns all positions with their health factors (for debugging)
 */
app.get("/positions-health", async (c) => {
  const publicClient = Object.values(publicClients)[0];

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

  // Fetch account data for each position (individual calls - works on any chain)
  const positionsWithHealth = [];

  for (const p of positions) {
    try {
      const accountData = await publicClient.readContract({
        address: spokeAddress,
        abi: spokeAbi,
        functionName: "getUserAccountData",
        args: [p.proxyAddress],
      });

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
    } catch (error) {
      positionsWithHealth.push({
        proxyAddress: p.proxyAddress,
        error: "Failed to fetch account data",
        errorDetails: (error as Error).message || "Unknown error",
      });
    }
  }

  return c.json(replaceBigInts({
    positions: positionsWithHealth,
    total: positions.length,
  }));
});

export default app;
