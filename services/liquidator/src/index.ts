import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { type Chain, type Hex, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { instrumentedHttp } from "@repo/chain";
import { createLogger } from "@repo/logger";
import { setPublicClient, startObservabilityServer, updateLastPollTime } from "@repo/observability";
import { LiquidationBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, recordRpcCall } from "./metrics";

const logger = createLogger({ prefix: "[Bot] " });

async function createBot(config: Config) {
  const account = privateKeyToAccount(config.liquidatorPrivateKey);
  logger.info(`Liquidator address: ${account.address}`);

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

  const bot = new LiquidationBot({
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
  });

  return { bot, publicClient };
}

async function main() {
  const command = process.argv[2] || "poll";
  const config = loadConfig();

  if (command === "poll") {
    logger.info("Aave V4 Liquidation Bot Starting...");
    const { bot, publicClient } = await createBot(config);

    // Start the observability server (metrics + health/readiness probes)
    setPublicClient(publicClient);
    startObservabilityServer({
      port: config.metricsPort,
      ponderUrl: config.ponderUrl,
      ponderHealthEndpoint: "/positions",
      getMetrics,
      getMetricsContentType,
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

    logger.info(
      `Redemption mode: ${config.isDirectRedemption ? "direct BTC" : "WBTC via VaultSwap"}`
    );
    logger.info(`Polling every ${config.pollingIntervalMs / 1000}s...`);
    logger.info("---");

    // Run loop — awaits each run before sleeping to prevent overlapping executions
    while (true) {
      logger.info(`[${new Date().toISOString()}] Checking...`);
      await bot.run();
      await bot.logBalances();
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
