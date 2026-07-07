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

import { instrumentedHttp } from "@repo/chain";
import { LiquidationEngine } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { setPublicClient, startObservabilityServer, updateLastPollTime } from "@repo/observability";
import { createRiskGate } from "@repo/risk";
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

  const bot = new ArbitrageurBot({
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
  });

  return { bot, publicClient, walletClient };
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
  publicClient: PublicClient
): Promise<void> {
  const liqLogger = createLogger({ prefix: "[Arbitrageur:Liq] " });
  const { pollingIntervalMs, ...params } = liq;

  const engine = new LiquidationEngine({
    ...params,
    walletClient,
    publicClient,
    metrics: createLiquidationMetricsSet(),
    logger: liqLogger,
    risk: createRiskGate(),
  });

  liqLogger.info("Liquidation engine enabled (running alongside arbitrage)");
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

  const { bot, publicClient, walletClient } = await createBot(config);

  // Start the observability server (metrics + health/readiness probes)
  setPublicClient(publicClient);
  startObservabilityServer({
    port: config.metricsPort,
    ponderUrl: config.ponderUrl,
    ponderHealthEndpoint: "/escrowed-vaults",
    getMetrics,
    getMetricsContentType,
  });

  // Opt-in: also run the liquidation engine (both engines, one process).
  if (config.liquidation) {
    await startLiquidationEngine(config.liquidation, walletClient, publicClient);
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
process.on("SIGINT", () => {
  logger.info("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("\nShutting down...");
  process.exit(0);
});

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
