import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { type Chain, createPublicClient, createWalletClient } from "viem";

import { createCodeHashReader, instrumentedHttp } from "@repo/chain";
import { createNonceAllocator, createNonceLease, nextNonce } from "@repo/execution";
import { createLogger } from "@repo/logger";
import { setPublicClient, startObservabilityServer, updateLastPollTime } from "@repo/observability";
import { type StateStore, createStateStore } from "@repo/persistence";
import { startRiskRuntime } from "@repo/risk";
import { createSecrets } from "@repo/secrets";
import { resolveSigner } from "@repo/signer";
import { LiquidationBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, recordRpcCall } from "./metrics";

const logger = createLogger({ prefix: "[Bot] " });

// Held at module scope so the signal handlers can release the DB pool on shutdown.
let storeForShutdown: StateStore | undefined;

async function createBot(config: Config) {
  // Secrets + signer sources are selected by config (env/aws, local/aws). For a `local`
  // signer we resolve the key ref via the secrets provider and hand the *value* to the
  // signer; `aws` (KMS) resolves nothing. The key is never a plaintext `Config` field.
  const secrets = createSecrets(config.secrets);
  const signer = await resolveSigner(config.signer, (ref) => secrets.get(ref));
  logger.info(`Liquidator signer: ${config.signer.source} (${signer.address})`);

  // Every viem call routes through `instrumentedHttp` so that each outbound
  // JSON-RPC method increments the `eth_rpc_calls_total{method=...}` counter.
  const transport = instrumentedHttp(config.rpcUrl, recordRpcCall);

  // Create custom chain - auto-detect chainId from RPC
  const tempClient = createPublicClient({
    transport,
  });
  const chainId = await tempClient.getChainId();
  logger.info(`Chain ID: ${chainId}`);

  const chain: Chain = {
    id: chainId,
    name: "Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [config.rpcUrl] },
    },
  };

  const publicClient = createPublicClient({
    chain,
    transport,
  });

  const walletClient = createWalletClient({
    chain,
    transport,
    account: signer.account,
  });

  // Crash-safety StateStore (Postgres) when configured; otherwise undefined (unchanged).
  const store = config.persistence ? createStateStore(config.persistence) : undefined;
  logger.info(`Persistence: ${store ? "postgres" : "disabled"}`);

  // The shared in-memory nonce authority. Seeded from the chain below (and every cycle in
  // `run()`), so it needs no persisted state. One per signer.
  const nonces = createNonceAllocator(createNonceLease(), signer.address);

  // Exactly ONE risk gate per process, injected into every engine — a kill-switch or tripped
  // breaker must halt everything this process drives. Also verifies the pinned adapter/lens
  // bytecode before any tx goes out, and prepares the authenticated kill-switch routes.
  const {
    gate: risk,
    routes,
    routeNames,
  } = await startRiskRuntime({
    config: config.risk,
    codeCheckIntervalMs: config.codeCheckIntervalMs,
    controlTokenRef: config.controlTokenRef,
    reader: createCodeHashReader(publicClient),
    getSecret: (ref) => secrets.get(ref),
    logger,
  });

  const bot = new LiquidationBot({
    risk,
    walletClient,
    publicClient,
    adapterAddress: config.adapterAddress,
    lensAddress: config.lensAddress,
    wbtcAddress: config.wbtcAddress,
    debtTokenAddresses: config.debtTokenAddresses,
    btcRedeemKey: config.btcRedeemKey,
    isDirectRedemption: config.isDirectRedemption,
    llpAddress: config.llpAddress,
    ponderUrl: config.ponderUrl,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    store,
    nonces,
  });

  // Seed the nonce lease from the chain before any send (approvals below reserve nonces).
  await nonces.resync(() => nextNonce(publicClient, signer.address));

  return { bot, publicClient, store, routes, routeNames };
}

async function main() {
  const command = process.argv[2] || "poll";
  const config = loadConfig();

  if (command === "poll") {
    logger.info("Aave V4 Liquidation Bot Starting...");
    const { bot, publicClient, store, routes, routeNames } = await createBot(config);
    storeForShutdown = store;

    // Start the observability server (metrics + health/readiness probes, and — when a control
    // token is configured — the authenticated kill-switch endpoints).
    setPublicClient(publicClient);
    startObservabilityServer({
      port: config.metricsPort,
      ponderUrl: config.ponderUrl,
      ponderHealthEndpoint: "/positions",
      getMetrics,
      getMetricsContentType,
      routes,
      routeNames,
    });

    // Discover or use configured debt tokens
    if (config.debtTokenAddresses) {
      logger.info(
        `Using ${config.debtTokenAddresses.length} debt token(s) from DEBT_TOKEN_ADDRESSES env var`
      );
    } else {
      await bot.discoverDebtTokens();
    }

    await bot.ensureApproval();
    await bot.logBalances();

    // Crash-safety: resolve any in-flight intents from a previous run against the chain
    // before the poll loop re-drives, so a crash mid-submit doesn't double-send. No-op
    // without a store.
    await bot.reconcile();

    logger.info(
      `Redemption mode: ${config.isDirectRedemption ? "direct BTC" : "WBTC via VaultSwap"}`
    );
    logger.info(`Polling every ${config.pollingIntervalMs / 1000}s...`);
    logger.info("---");

    // Run loop — awaits each run before sleeping to prevent overlapping executions.
    // Wrap the cycle so an unexpected throw logs and reschedules instead of
    // crashing the process (parity with the arbitrageur's poll loop).
    while (true) {
      logger.info(`[${new Date().toISOString()}] Checking...`);
      try {
        await bot.run();
        await bot.logBalances();
      } catch (error) {
        logger.error("Unexpected error in poll cycle:", error);
      }
      updateLastPollTime();
      logger.info("---");
      await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
    }
  } else {
    logger.error(`Unknown command: ${command}`);
    logger.error("Available commands: poll (default)");
    process.exit(1);
  }
}

async function shutdown() {
  logger.info("\nShutting down...");
  await storeForShutdown?.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
