import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { createLogger } from "@repo/logger";
import { updateLastPollTime } from "@repo/observability";
import { startRuntime } from "@repo/runtime";
import { LiquidationBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, recordRpcCall } from "./metrics";

const logger = createLogger({ prefix: "[Bot] " });

async function createBot(config: Config): Promise<LiquidationBot> {
  // The shared runtime boots everything mode-independent + the one executor (AUTO signer or keyless
  // MANUAL), starts the metrics/health server, and registers graceful shutdown. The kill switch is
  // NOT on that server: `startRiskRuntime` serves it on its own socket, so the metrics port stays
  // safe to expose to a scrape network. This service just adds the liquidation engine on top.
  const { publicClient, risk, executor } = await startRuntime(config, {
    recordRpcCall,
    logger,
    observability: {
      port: config.metricsPort,
      ponderUrl: config.ponderUrl,
      ponderHealthEndpoint: "/positions",
      getMetrics,
      getMetricsContentType,
    },
  });

  return new LiquidationBot({
    risk,
    publicClient,
    executor,
    adapterAddress: config.adapterAddress,
    lensAddress: config.lensAddress,
    wbtcAddress: config.wbtcAddress,
    debtTokenAddresses: config.debtTokenAddresses,
    btcRedeemKey: config.btcRedeemKey,
    isDirectRedemption: config.isDirectRedemption,
    llpAddress: config.llpAddress,
    ponderUrl: config.ponderUrl,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    funding: config.funding,
  });
}

async function main() {
  const command = process.argv[2] || "poll";
  const config = loadConfig();

  if (command === "poll") {
    logger.info("Aave V4 Liquidation Bot Starting...");
    const bot = await createBot(config);

    // Discover or use configured debt tokens
    if (config.debtTokenAddresses) {
      logger.info(
        `Using ${config.debtTokenAddresses.length} debt token(s) from DEBT_TOKEN_ADDRESSES env var`
      );
    }

    // Discovery, plus whatever the funding mode needs before it can trade: inventory funding
    // approves the adapter here, flash funding approves nothing.
    await bot.prepare();
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

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
