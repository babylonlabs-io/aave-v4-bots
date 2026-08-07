import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { VAULT_GONE_ERRORS, lensAbi, vaultSwapAbi } from "@repo/abis";
import { createLogger } from "@repo/logger";
import { Hono } from "hono";
import { client, graphql, replaceBigInts as replaceBigIntsBase } from "ponder";
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { Address, PublicClient } from "viem";

const logger = createLogger();

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

// `previewEscrowedVaults` validates every vault it is given and reverts the whole call if any one
// of them has left escrow. The indexer lags the chain, so it routinely still lists vaults that were
// just acquired — those are gone, not broken, and must not be reported as fetch failures. Decoding
// this relies on the error entries in `vaultSwapAbi`; without them viem yields no `errorName` and
// every acquired vault would look like an infrastructure fault again.
const vaultGoneErrors: ReadonlySet<string> = new Set(VAULT_GONE_ERRORS);

function isVaultGoneRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return (
    revert instanceof ContractFunctionRevertedError &&
    revert.data?.errorName !== undefined &&
    vaultGoneErrors.has(revert.data.errorName)
  );
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
      logger.warn(
        `Multicall3 not deployed at ${MULTICALL3_ADDRESS}; falling back to per-position readContract. Set MULTICALL3_ADDRESS or deploy Multicall3 to recover the batched-RPC savings.`
      );
    }
    return multicallSupported;
  } catch (error) {
    logger.warn("Multicall3 probe failed; falling back to per-position readContract:", error);
    multicallSupported = false;
    return false;
  }
}

/**
 * The block this endpoint's **live** contract reads are pinned to, and its timestamp.
 *
 * Read the block *and* pin every subsequent `eth_call` to it, so `dataTimestampMs` describes the
 * exact state the caller is being handed. Timestamping one block and then reading at "latest"
 * would decouple the two: a load-balanced RPC URL can serve the reads from a lagging replica, and
 * a reorg can replace the head between the calls — either way the reported age would not be the
 * age of the data, which is precisely what the risk gate's freshness guard relies on.
 *
 * Clients pass the timestamp to the risk gate as `dataTimestampMs`: if the RPC behind this indexer
 * is lagging, `now - dataTimestampMs` exceeds the freshness threshold and the action is blocked.
 * Note it measures *RPC* staleness, not indexer **head** lag — that is a separate guard the
 * indexer-liveness work owns.
 *
 * A failed probe returns `undefined`, and the reads fall back to unpinned "latest". Be clear about
 * what that means downstream: the risk gate is **fail-closed** on freshness. A client with
 * `RISK_MAX_DATA_STALENESS_MS` set will block *every* action when the timestamp is missing — it
 * will not "skip the guard". That is the safe direction (never trade on data of unknown age), but
 * it means a sustained failure of this probe stops the bot trading while this endpoint still
 * returns 200 with candidates. Alert on the warning below, not just on HTTP status.
 */
interface BlockRef {
  /** Pin live reads here, so the data and the timestamp describe the same state. */
  blockNumber: bigint;
  dataTimestampMs: number;
}

async function readBlockRef(publicClient: PublicClient): Promise<BlockRef | undefined> {
  try {
    const block = await publicClient.getBlock();
    // `getBlock()` defaults to the latest *mined* block, so `number` is never null here.
    if (block.number === null) return undefined;
    return { blockNumber: block.number, dataTimestampMs: Number(block.timestamp) * 1000 };
  } catch (error) {
    // The severity is the point: a client with RISK_MAX_DATA_STALENESS_MS set fail-closes on the
    // missing field and stops submitting entirely, while this endpoint keeps returning 200 with
    // candidates. This line is the only signal of that, so it must not read as benign.
    logger.warn(
      "Could not read block timestamp; omitting dataTimestampMs — clients with " +
        "RISK_MAX_DATA_STALENESS_MS set will BLOCK every action until this recovers:",
      error
    );
    return undefined;
  }
}

const app = new Hono();

// GraphQL endpoint
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

// SQL client endpoint
app.use("/sql/*", client({ db, schema }));

// ── liquidation endpoints ────────────────────────────────────────────────────

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

  // Pin the live `estimateLiquidation` reads below to one block, and report its timestamp as the
  // risk-gate `dataTimestampMs`. `blockNumber: undefined` (failed probe) means unpinned "latest".
  const blockRef = await readBlockRef(publicClient);
  const dataTimestampMs = blockRef?.dataTimestampMs;

  // Build proxy -> borrower lookup
  const proxyToBorrower = new Map<string, string>();
  for (const m of proxyMappings) {
    proxyToBorrower.set(m.proxyAddress.toLowerCase(), m.borrower);
  }

  // estimateLiquidation reverts for healthy positions and returns
  // [amounts, wbtcPayment, vaults] for liquidatable ones. The wbtcPayment is
  // pulled directly from msg.sender by the adapter at liquidation time, so the
  // API response doesn't need to expose it — the client just needs enough WBTC
  // approved + balance. We unify both paths to a
  // { status: "success" | "failure", value/error } shape so the loop below
  // doesn't care which one ran.
  type Probe =
    | {
        status: "success";
        value: readonly [readonly bigint[], bigint, readonly `0x${string}`[]];
      }
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
      blockNumber: blockRef?.blockNumber,
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
          blockNumber: blockRef?.blockNumber,
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
        logger.warn(
          `estimateLiquidation error for ${p.proxyAddress} (not a contract revert):`,
          probe.error instanceof Error ? probe.error.message : probe.error
        );
      }
      continue;
    }

    const borrower = proxyToBorrower.get(p.proxyAddress.toLowerCase());
    if (!borrower) {
      logger.error(`No borrower mapping found for proxy ${p.proxyAddress}`);
      continue;
    }

    const [amounts, , vaults] = probe.value;

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
      dataTimestampMs,
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

// ── arbitrage endpoints ──────────────────────────────────────────────────────

/**
 * GET /escrowed-vaults
 *
 * Returns all escrowed vaults with live debt data from VaultSwap contract.
 * Uses a single batch call to previewEscrowedVaults for efficiency.
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

  // Pin the live `previewEscrowedVaults` reads below to one block, and report its timestamp as the
  // risk-gate `dataTimestampMs`. `blockNumber: undefined` (failed probe) means unpinned "latest".
  const blockRef = await readBlockRef(publicClient);
  const dataTimestampMs = blockRef?.dataTimestampMs;

  // Build vault ID array and createdAt lookup
  const vaultIds = vaults.map((v) => v.vaultId);
  const createdAtMap = new Map(vaults.map((v) => [v.vaultId, v.createdAt]));
  const toApiVault = (info: {
    vaultId: `0x${string}`;
    amountVault: bigint;
    amountDebt: bigint;
    amountInterest: bigint;
    amountFee: bigint;
    amountWbtcEquivalent: bigint;
    amountWbtcToAcquire: bigint;
    amountProfitEst: bigint;
  }) => ({
    vaultId: info.vaultId,
    btcAmount: info.amountVault.toString(),
    currentDebt: info.amountWbtcToAcquire.toString(),
    isProfitable: info.amountProfitEst > 0n,
    createdAt: createdAtMap.get(info.vaultId)?.toString() ?? "0",
  });

  try {
    // Single batch RPC call to get info for all vaults
    const vaultsInfo = await publicClient.readContract({
      address: vaultSwapAddress,
      abi: vaultSwapAbi,
      functionName: "previewEscrowedVaults",
      args: [vaultIds],
      blockNumber: blockRef?.blockNumber,
    });

    const enrichedVaults = vaultsInfo.map(toApiVault);

    return c.json(
      replaceBigInts({
        vaults: enrichedVaults,
        total: enrichedVaults.length,
        failedVaultsCount: 0,
        dataTimestampMs,
      })
    );
  } catch (error) {
    // Deliberately not logged yet. The overwhelmingly common cause is a vault acquired between the
    // index read and this call, which reverts the whole batch — routine, and the per-vault pass
    // below is what can tell that apart from a real fault. Logging here would put an error line on
    // every poll of a draining escrow, which is the noise this endpoint is meant to stop emitting.
    const settled = await Promise.allSettled(
      vaultIds.map((vaultId) =>
        publicClient.readContract({
          address: vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "previewEscrowedVaults",
          args: [[vaultId]],
          blockNumber: blockRef?.blockNumber,
        })
      )
    );

    const enrichedVaults = [];
    let failed = 0;
    let gone = 0;

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const vaultId = vaultIds[i];
      if (result.status === "fulfilled" && result.value.length > 0) {
        enrichedVaults.push(toApiVault(result.value[0]));
      } else if (result.status === "rejected" && isVaultGoneRevert(result.reason)) {
        // Already acquired between the index read and now. Omit it and say nothing: this is the
        // steady state while the escrow drains, not a fault to report or retry.
        gone += 1;
      } else {
        failed += 1;
        logger.error(
          `Failed to fetch vault info for ${vaultId}:`,
          result.status === "rejected" ? result.reason : "empty response"
        );
      }
    }

    // Now the batch failure can be reported at its true severity: an error only if some vault
    // failed for a reason other than having been acquired.
    if (failed > 0) {
      logger.error("Batch previewEscrowedVaults failed, fell back to per-vault fetch:", error);
    } else if (gone > 0) {
      logger.info(
        `Batch previewEscrowedVaults skipped: ${gone} vault(s) acquired since the last index update`
      );
    }

    // 500 only when something genuinely broke. An empty list because every vault was acquired is a
    // valid, complete answer — previously it returned 500 and drove the bot through its full fetch
    // retry/backoff on every poll once the escrow was drained.
    return c.json(
      replaceBigInts({
        vaults: enrichedVaults,
        total: enrichedVaults.length,
        failedVaultsCount: failed,
        dataTimestampMs,
      }),
      enrichedVaults.length > 0 || failed === 0 ? 200 : 500
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
