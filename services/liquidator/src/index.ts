import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { createIndexer } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { startRuntime } from "@repo/runtime";
import { LiquidationBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { getMetrics, getMetricsContentType, indexerMetrics, runtimeMetrics } from "./metrics";

const logger = createLogger({ prefix: "[Bot] " });

async function createBot(config: Config): Promise<LiquidationBot> {
  // The shared runtime boots everything mode-independent + the one executor (AUTO signer or keyless
  // MANUAL), starts the metrics/health server, and registers graceful shutdown. The kill switch is
  // NOT on that server: `startRiskRuntime` serves it on its own socket, so the metrics port stays
  // safe to expose to a scrape network. This service just adds the liquidation engine on top.
  const { publicClient, risk, executor } = await startRuntime(config, {
    metrics: runtimeMetrics,
    logger,
    observability: {
      port: config.metricsPort,
      host: config.metricsHost,
      ponderUrl: config.ponderUrl,
      // Ponder's own readiness, not a data route: a wedged indexer still answers `/positions`
      // with a stale 200, which is exactly the state this probe must not call healthy.
      ponderHealthEndpoint: "/ready",
      getMetrics,
      getMetricsContentType,
    },
  });

  // ONE indexer for the process: the reads and the liveness verdict, built from the base URL and
  // the process retry policy, so nothing can read it with a different policy — or unchecked.
  const indexer = createIndexer({
    baseUrl: config.ponderUrl,
    retry: config.retryConfig,
    chainId: executor.identity.chainId,
    getRpcHead: () => publicClient.getBlockNumber(),
    risk,
    logger,
    metrics: indexerMetrics,
    config: config.indexer,
  });

  // Refuse to trade on a half-built worldview. During backfill the candidate list is arbitrarily
  // incomplete and the lag guard cannot see it, because the checkpoint is legitimately old.
  //
  // Opt-in: unset ⇒ start immediately. Waiting is a constraint on *startup*, so a deployment whose
  // backfill legitimately runs long chooses it rather than inheriting it from a default.
  const readyTimeoutMs = config.indexer.readyTimeoutMs;
  if (
    readyTimeoutMs !== undefined &&
    !(await indexer.waitUntilReady({
      timeoutMs: readyTimeoutMs,
      onWaiting: () =>
        logger.info("Waiting for the indexer to finish backfilling before trading..."),
    }))
  ) {
    throw new Error(
      `Indexer at ${config.ponderUrl} was not ready within ${readyTimeoutMs}ms — refusing to trade on partially indexed history.`
    );
  }

  return new LiquidationBot({
    risk,
    publicClient,
    executor,
    adapterAddress: config.adapterAddress,
    lensAddress: config.lensAddress,
    wbtcAddress: config.wbtcAddress,
    btcRedeemKey: config.btcRedeemKey,
    isDirectRedemption: config.isDirectRedemption,
    llpAddress: config.llpAddress,
    indexer,
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
