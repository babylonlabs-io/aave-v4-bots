import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.arbitrageur from root directory BEFORE importing config
dotenvConfig({ path: resolve(process.cwd(), ".env.arbitrageur") });

import { type Chain, type PublicClient, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { instrumentedHttp } from "@repo/chain";
import { createLogger } from "@repo/logger";
import { setPublicClient, startObservabilityServer } from "@repo/observability";
import { ArbitrageurBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, recordRpcCall } from "./metrics";

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
}

async function createBot(config: Config): Promise<BotWithClients> {
  const account = privateKeyToAccount(config.arbitrageurPrivateKey);
  logger.info(`Arbitrageur address: ${account.address}`);

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
    account,
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

  return { bot, publicClient };
}

async function runPollingMode(config: Config): Promise<void> {
  logger.info("Aave V4 Arbitrageur Bot Starting...");
  logger.info("===================================");

  const { bot, publicClient } = await createBot(config);

  // Start the observability server (metrics + health/readiness probes)
  setPublicClient(publicClient);
  startObservabilityServer({
    port: config.metricsPort,
    ponderUrl: config.ponderUrl,
    ponderHealthEndpoint: "/escrowed-vaults",
    getMetrics,
    getMetricsContentType,
  });

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
