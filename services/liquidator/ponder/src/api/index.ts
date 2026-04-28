import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import { ContractFunctionRevertedError } from "viem";
import type { Address, PublicClient } from "viem";

import { lensAbi } from "../../abis/Lens";

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
 * GET /liquidatable-positions
 *
 * Returns all positions that are liquidatable by calling estimateLiquidation
 * on the AaveAdapterLens contract. The call reverts for healthy positions
 * and succeeds for liquidatable ones, returning the required inputs and vaults.
 */
app.get("/liquidatable-positions", async (c) => {
  const publicClient = Object.values(publicClients)[0] as PublicClient | undefined;

  if (!publicClient) {
    return c.json({ error: "No public client configured" }, 500);
  }

  const lensAddress = process.env.LENS_ADDRESS as Address;
  if (!lensAddress) {
    return c.json({ error: "LENS_ADDRESS not configured" }, 500);
  }

  // Query all positions and proxy mappings from database
  const [positions, proxyMappings] = await Promise.all([
    db.query.position.findMany(),
    db.query.proxyMapping.findMany(),
  ]);

  if (positions.length === 0) {
    return c.json({ liquidatable: [], total: 0, checked: 0 });
  }

  // Build proxy -> borrower lookup
  const proxyToBorrower = new Map<string, string>();
  for (const m of proxyMappings) {
    proxyToBorrower.set(m.proxyAddress.toLowerCase(), m.borrower);
  }

  // Batch all estimateLiquidation calls into a single Multicall3 RPC.
  // estimateLiquidation reverts for healthy positions; with allowFailure=true,
  // each per-call revert surfaces as { status: "failure" } without aborting the batch.
  const multicallAddress = (process.env.MULTICALL3_ADDRESS ||
    "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;

  const results = await publicClient.multicall({
    contracts: positions.map((p) => ({
      address: lensAddress,
      abi: lensAbi,
      functionName: "estimateLiquidation" as const,
      args: [p.proxyAddress as Address, false] as const,
    })),
    allowFailure: true,
    multicallAddress,
  });

  const liquidatable: Array<{
    proxyAddress: string;
    borrower: string;
    amounts: string[];
    vaults: string[];
    suppliedShares: string;
  }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const p = positions[i];

    if (result.status === "failure") {
      // Most failures are expected reverts ("Position is not undercollateralized").
      // Anything else (e.g. multicall infrastructure error) is logged.
      const isExpectedRevert = result.error instanceof ContractFunctionRevertedError;
      if (!isExpectedRevert) {
        console.warn(
          `estimateLiquidation multicall error for ${p.proxyAddress} (not a revert):`,
          result.error instanceof Error ? result.error.message : result.error
        );
      }
      continue;
    }

    const borrower = proxyToBorrower.get(p.proxyAddress.toLowerCase());
    if (!borrower) {
      console.error(`No borrower mapping found for proxy ${p.proxyAddress}`);
      continue;
    }

    const [amounts, vaults] = result.result;

    liquidatable.push({
      proxyAddress: p.proxyAddress,
      borrower,
      amounts: amounts.map((amt) => amt.toString()),
      vaults: vaults as string[],
      suppliedShares: p.suppliedShares.toString(),
    });
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

export default app;
