import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { Address, PublicClient } from "viem";

import { lensAbi } from "../../abis/Lens";

function replaceBigInts<T>(value: T) {
  return replaceBigIntsBase(value, (x) => String(x));
}

// viem wraps on-chain reverts as ContractFunctionExecutionError whose `.cause` is
// ContractFunctionRevertedError, so a bare instanceof check on the top-level error
// always fails. Walk the cause chain instead.
function isExpectedContractRevert(error: unknown): boolean {
  if (error instanceof BaseError) {
    return error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
  }
  return false;
}

// Multicall3 is canonically deployed at this address on most public chains, but
// not on bare Anvil instances or freshly-bootstrapped private chains. Probe once
// per process and cache the result; if it's missing, fall back to per-position
// readContract so the bot still works (just without the savings).
const MULTICALL3_ADDRESS = (process.env.MULTICALL3_ADDRESS ||
  "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;

let multicallSupported: boolean | undefined;

async function isMulticallSupported(publicClient: PublicClient): Promise<boolean> {
  if (multicallSupported !== undefined) return multicallSupported;
  try {
    const code = await publicClient.getCode({ address: MULTICALL3_ADDRESS });
    multicallSupported = !!code && code !== "0x";
    if (!multicallSupported) {
      console.warn(
        `Multicall3 not deployed at ${MULTICALL3_ADDRESS}; falling back to per-position readContract. Set MULTICALL3_ADDRESS or deploy Multicall3 to recover the batched-RPC savings.`
      );
    }
    return multicallSupported;
  } catch (error) {
    console.warn("Multicall3 probe failed; falling back to per-position readContract:", error);
    multicallSupported = false;
    return false;
  }
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

  // estimateLiquidation reverts for healthy positions and returns
  // [amounts, vaults] for liquidatable ones. We unify both paths to a
  // { status: "success" | "failure", value/error } shape so the loop below
  // doesn't care which one ran.
  type Probe =
    | { status: "success"; value: readonly [readonly bigint[], readonly `0x${string}`[]] }
    | { status: "failure"; error: unknown };

  let probes: Probe[];

  if (await isMulticallSupported(publicClient)) {
    // One eth_call to Multicall3.aggregate3 covering N positions.
    const results = await publicClient.multicall({
      contracts: positions.map((p) => ({
        address: lensAddress,
        abi: lensAbi,
        functionName: "estimateLiquidation" as const,
        args: [p.proxyAddress as Address, false] as const,
      })),
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    });
    probes = results.map((r) =>
      r.status === "success"
        ? { status: "success", value: r.result }
        : { status: "failure", error: r.error }
    );
  } else {
    // Fallback: N parallel readContract calls (the pre-multicall behavior).
    const settled = await Promise.allSettled(
      positions.map((p) =>
        publicClient.readContract({
          address: lensAddress,
          abi: lensAbi,
          functionName: "estimateLiquidation",
          args: [p.proxyAddress as Address, false],
        })
      )
    );
    probes = settled.map((s) =>
      s.status === "fulfilled"
        ? { status: "success", value: s.value }
        : { status: "failure", error: s.reason }
    );
  }

  const liquidatable: Array<{
    proxyAddress: string;
    borrower: string;
    amounts: string[];
    vaults: string[];
    suppliedShares: string;
  }> = [];

  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    const p = positions[i];

    if (probe.status === "failure") {
      // Healthy positions revert by design; anything else is a real RPC error.
      if (!isExpectedContractRevert(probe.error)) {
        console.warn(
          `estimateLiquidation error for ${p.proxyAddress} (not a contract revert):`,
          probe.error instanceof Error ? probe.error.message : probe.error
        );
      }
      continue;
    }

    const borrower = proxyToBorrower.get(p.proxyAddress.toLowerCase());
    if (!borrower) {
      console.error(`No borrower mapping found for proxy ${p.proxyAddress}`);
      continue;
    }

    const [amounts, vaults] = probe.value;

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
