import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.arbitrageur from root directory BEFORE importing config
dotenvConfig({ path: resolve(process.cwd(), ".env.arbitrageur") });

import {
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";

import { createCodeHashReader, instrumentedHttp } from "@repo/chain";
import { LiquidationEngine } from "@repo/engine";
import {
  type NonceAllocator,
  createNonceAllocator,
  createNonceLease,
  nextNonce,
} from "@repo/execution";
import { createLogger } from "@repo/logger";
import {
  type HttpRoute,
  setPublicClient,
  startObservabilityServer,
  updateLastPollTime,
} from "@repo/observability";
import { type StateStore, createStateStore } from "@repo/persistence";
import { type RiskGate, startRiskRuntime } from "@repo/risk";
import { createSecrets } from "@repo/secrets";
import { resolveSigner } from "@repo/signer";
import { ArbitrageurBot } from "./bot";
import { type Config, type LiquidationRunConfig, loadConfig } from "./config";
import {
  createLiquidationMetricsSet,
  getMetrics,
  getMetricsContentType,
  recordRpcCall,
} from "./metrics";

const logger = createLogger({ prefix: "[Arbitrageur] " });

// Held at module scope so the signal handlers can release the DB pool on shutdown.
let storeForShutdown: StateStore | undefined;

function printUsage(): void {
  logger.info(`
Aave V4 Arbitrageur Bot

Usage:
  pnpm arbitrage                     Start polling mode (default)
  pnpm arbitrage help                Show this help message

Environment variables:
  See env.example for required configuration
`);
}

interface BotWithClients {
  bot: ArbitrageurBot;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  store: StateStore | undefined;
  nonces: NonceAllocator;
  risk: RiskGate;
  routes: readonly HttpRoute[];
  routeNames: readonly string[];
}

async function createBot(config: Config): Promise<BotWithClients> {
  // Secrets + signer sources are selected by config (env/aws, local/aws). For a `local`
  // signer we resolve the key ref via the secrets provider and hand the *value* to the
  // signer; `aws` (KMS) resolves nothing. The key is never a plaintext `Config` field.
  // Both engines (arbitrage + optional liquidation) share this one signer.
  const secrets = createSecrets(config.secrets);
  const signer = await resolveSigner(config.signer, (ref) => secrets.get(ref));
  logger.info(`Arbitrageur signer: ${config.signer.source} (${signer.address})`);

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

  // Crash-safety StateStore (Postgres) shared by both engines when configured.
  const store = config.persistence ? createStateStore(config.persistence) : undefined;
  logger.info(`Persistence: ${store ? "postgres" : "disabled"}`);

  // ONE shared nonce authority for the signer — both engines route every tx through it, so
  // their concurrent sends never collide. In-memory (chain-seeded), no persisted state.
  const nonces = createNonceAllocator(createNonceLease(), signer.address);

  // ONE shared risk gate for the process — injected into BOTH engines, so a kill-switch or a
  // tripped breaker halts arbitrage *and* liquidation together. (Each engine used to build its
  // own gate, which meant halting one left the other trading.) Also verifies the pinned target
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

  const bot = new ArbitrageurBot({
    risk,
    walletClient,
    publicClient,
    vaultSwapAddress: config.vaultSwapAddress,
    wbtcAddress: config.wbtcAddress,
    ponderUrl: config.ponderUrl,
    maxSlippageBps: config.maxSlippageBps,
    vaultProcessingDelayMs: config.vaultProcessingDelayMs,
    retryConfig: {
      maxAttempts: config.retryMaxAttempts,
      initialDelayMs: config.retryInitialDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      backoffMultiplier: 2,
    },
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    store,
    nonces,
  });

  // Seed the shared lease from the chain once, before either engine sends.
  await nonces.resync(() => nextNonce(publicClient, signer.address));

  return { bot, publicClient, walletClient, store, nonces, risk, routes, routeNames };
}

/**
 * Opt-in second engine: when liquidation env is configured, the arbitrageur also
 * runs the shared `LiquidationEngine` — same signer + clients + metrics registry,
 * its own tagged logger and poll loop. This is the "arbitrageur runs both engines"
 * composition the two-engine split exists for.
 */
async function startLiquidationEngine(
  liq: LiquidationRunConfig,
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: PublicClient,
  store: StateStore | undefined,
  nonces: NonceAllocator,
  risk: RiskGate
): Promise<void> {
  const liqLogger = createLogger({ prefix: "[Arbitrageur:Liq] " });
  const { pollingIntervalMs, ...params } = liq;

  const engine = new LiquidationEngine({
    ...params,
    walletClient,
    publicClient,
    metrics: createLiquidationMetricsSet(),
    logger: liqLogger,
    // The SAME gate and allocator the arbitrage engine uses: one risk authority and one nonce
    // owner per process, so halting or nonce-sequencing covers both engines.
    risk,
    store,
    nonces,
  });

  liqLogger.info(`Liquidation engine enabled (persistence: ${store ? "postgres" : "disabled"})`);
  if (!params.debtTokenAddresses) {
    await engine.discoverDebtTokens();
  }
  await engine.ensureApproval();
  await engine.logBalances();

  const poll = async () => {
    try {
      await engine.run();
      await engine.logBalances();
    } catch (error) {
      liqLogger.error("Unexpected error in liquidation poll cycle:", error);
    }
    updateLastPollTime();
    setTimeout(poll, pollingIntervalMs);
  };
  // Kick off without awaiting the first cycle — the two engines poll independently
  // (a liquidation tx wait must not stall the arbitrage loop).
  void poll();
}

async function runPollingMode(config: Config): Promise<void> {
  logger.info("Aave V4 Arbitrageur Bot Starting...");
  logger.info("===================================");

  const { bot, publicClient, walletClient, store, nonces, risk, routes, routeNames } =
    await createBot(config);
  storeForShutdown = store;

  // Start the observability server (metrics + health/readiness probes, and — when a control
  // token is configured — the authenticated kill-switch endpoints). One `control` for the
  // process: halting it stops the arbitrage engine AND the optional liquidation engine.
  setPublicClient(publicClient);
  startObservabilityServer({
    port: config.metricsPort,
    ponderUrl: config.ponderUrl,
    ponderHealthEndpoint: "/escrowed-vaults",
    getMetrics,
    getMetricsContentType,
    routes,
    routeNames,
  });

  // Opt-in: also run the liquidation engine (both engines, one process) — sharing the one
  // nonce allocator so the two engines' concurrent sends never collide on the signer.
  if (config.liquidation) {
    await startLiquidationEngine(
      config.liquidation,
      walletClient,
      publicClient,
      store,
      nonces,
      risk
    );
  }

  logger.info(`Max slippage: ${config.maxSlippageBps / 100}%`);
  logger.info(`Retry attempts: ${config.retryMaxAttempts}`);
  logger.info(`Transaction timeout: ${config.txReceiptTimeoutMs / 1000}s`);

  // Log initial balance
  await bot.logBalance();

  logger.info(`Polling every ${config.pollingIntervalMs / 1000}s...`);
  logger.info(`Delay between vaults: ${config.vaultProcessingDelayMs / 1000}s`);
  logger.info("---");

  // Polling loop using recursive setTimeout to prevent overlapping cycles
  const poll = async () => {
    logger.info("---");
    logger.info(`[${new Date().toISOString()}] Checking for escrowed vaults...`);

    try {
      await bot.run();
      await bot.logBalance();
    } catch (error) {
      logger.error("Unexpected error in poll cycle:", error);
    }

    // Schedule next poll after current one completes
    setTimeout(poll, config.pollingIntervalMs);
  };

  // Start first poll immediately
  await poll();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "poll";

  // Handle help command before loading config
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // Load and validate config (fails fast with clear errors)
  const config = loadConfig();

  switch (command) {
    case "poll":
    case "start":
      await runPollingMode(config);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Graceful shutdown
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
