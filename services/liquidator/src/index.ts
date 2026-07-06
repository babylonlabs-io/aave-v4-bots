import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { type Chain, createPublicClient, createWalletClient } from "viem";

import { instrumentedHttp } from "@repo/chain";
import { createLogger } from "@repo/logger";
import { setPublicClient, startObservabilityServer, updateLastPollTime } from "@repo/observability";
import { createEnvSecrets } from "@repo/secrets";
import { createLocalSigner } from "@repo/signer";
import { LiquidationBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, recordRpcCall } from "./metrics";

const logger = createLogger({ prefix: "[Bot] " });

async function createBot(config: Config) {
  // The signing key is a secret resolved at boot; the account/key lives in
  // `@repo/signer` (a KMS signer is a drop-in — see refactor-002 Phase C / #1).
  const secrets = createEnvSecrets();
  const signer = createLocalSigner(await secrets.get("LIQUIDATOR_PRIVATE_KEY"));
  logger.info(`Liquidator address: ${signer.address}`);

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
