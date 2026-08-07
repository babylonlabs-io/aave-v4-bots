import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.arbitrageur from root directory BEFORE importing config
dotenvConfig({ path: resolve(process.cwd(), ".env.arbitrageur") });

import type { PublicClient } from "viem";

import { type Executor, type Indexer, LiquidationEngine, createIndexer } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { updateLastPollTime } from "@repo/observability";
import type { RiskGate } from "@repo/risk";
import { startRuntime } from "@repo/runtime";
import { ArbitrageurBot } from "./bot";
import { type Config, type LiquidationRunConfig, loadConfig } from "./config";
import {
  createLiquidationMetricsSet,
  getMetrics,
  getMetricsContentType,
  indexerMetrics,
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
  /** Built once here so both engines read the indexer identically and share one incident clock. */
  indexer: Indexer;
  /**
   * The ONE execution collaborator for the whole process, injected into every engine — the same
   * "one per process" shape as the single risk gate. AUTO signs+broadcasts off the shared signer +
   * nonce authority; MANUAL is keyless (proposals from the operator's address). Both engines the
   * arbitrageur runs share this instance, so they can never collide on a nonce.
   */
  executor: Executor;
  risk: RiskGate;
}

async function createBot(config: Config): Promise<BotWithClients> {
  // The shared runtime boots everything mode-independent + the ONE executor (AUTO signer or keyless
  // MANUAL) that both engines this process runs will share, starts the metrics/health server, and
  // registers graceful shutdown. The kill switch is NOT on that server — `startRiskRuntime` serves it
  // on its own socket. This service adds the arbitrage engine on top, and (optionally) a second
  // liquidation engine off the same executor.
  const { publicClient, risk, executor } = await startRuntime(config, {
    recordRpcCall,
    logger,
    observability: {
      port: config.metricsPort,
      ponderUrl: config.ponderUrl,
      // Ponder's own readiness, not a data route: a wedged indexer still answers
      // `/escrowed-vaults` with a stale 200, which is exactly what this probe must not call healthy.
      ponderHealthEndpoint: "/ready",
      getMetrics,
      getMetricsContentType,
    },
  });

  // Refuse to trade on a half-built worldview — during backfill the lists are arbitrarily
  // incomplete and the lag guard cannot see it, because the checkpoint is legitimately old.
  //
  // Opt-in: unset ⇒ start immediately. Waiting is a constraint on *startup*, so a deployment whose
  // backfill legitimately runs long chooses it rather than inheriting it from a default.
  // ONE indexer for the process, handed to both engines below: the reads and the liveness verdict
  // together. Two of these would each keep their own incident clock against the same indexer, so a
  // single outage would be counted twice and the halt would fire at half the configured duration.
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

  const bot = new ArbitrageurBot({
    risk,
    publicClient,
    executor,
    vaultSwapAddress: config.vaultSwapAddress,
    wbtcAddress: config.wbtcAddress,
    vaultKeeperAddress: config.vaultKeeperAddress,
    indexer,
    maxSlippageBps: config.maxSlippageBps,
    vaultProcessingDelayMs: config.vaultProcessingDelayMs,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    funding: config.funding,
  });
  return { bot, publicClient, executor, risk, indexer };
}

/**
 * Opt-in second engine: when liquidation env is configured, the arbitrageur also
 * runs the shared `LiquidationEngine` — same signer + clients + metrics registry,
 * its own tagged logger and poll loop. This is the "arbitrageur runs both engines"
 * composition the two-engine split exists for.
 */
async function startLiquidationEngine(
  liq: LiquidationRunConfig,
  publicClient: PublicClient,
  executor: Executor,
  risk: RiskGate,
  indexer: Indexer
): Promise<void> {
  const liqLogger = createLogger({ prefix: "[Arbitrageur:Liq] " });
  const { pollingIntervalMs, ...params } = liq;

  const engine = new LiquidationEngine({
    ...params,
    publicClient,
    metrics: createLiquidationMetricsSet(),
    logger: liqLogger,
    // The SAME gate and executor the arbitrage engine uses: one risk authority and one execution
    // collaborator per process (one nonce owner in AUTO; one keyless proposer in MANUAL), so both
    // engines act as one.
    risk,
    executor,
    // The same instance the arbitrage engine holds — see `createBot`.
    indexer,
    onPollComplete: updateLastPollTime,
  });

  liqLogger.info(`Liquidation engine enabled (execution: ${executor.mode})`);
  // Discovery + mode-appropriate setup; see the liquidator's equivalent.
  await engine.prepare();
  await engine.logBalances();

  const poll = async () => {
    try {
      await engine.run();
      await engine.logBalances();
    } catch (error) {
      liqLogger.error("Unexpected error in liquidation poll cycle:", error);
    }
    setTimeout(poll, pollingIntervalMs);
  };
  // Kick off without awaiting the first cycle — the two engines poll independently
  // (a liquidation tx wait must not stall the arbitrage loop).
  void poll();
}

async function runPollingMode(config: Config): Promise<void> {
  logger.info("Aave V4 Arbitrageur Bot Starting...");
  logger.info("===================================");

  const { bot, publicClient, executor, risk, indexer } = await createBot(config);

  // Boot-time setup for the funding mode, BEFORE any poll loop starts. Router funding verifies the
  // router's immutables and the treasury's approval here, and this process may also run a
  // liquidation engine off the same signer — starting that first would let it broadcast while the
  // arbitrage configuration is still unproven, which is exactly what failing at boot is for.
  await bot.prepare();

  // Opt-in: also run the liquidation engine (both engines, one process) — sharing the one
  // nonce allocator so the two engines' concurrent sends never collide on the signer.
  if (config.liquidation) {
    await startLiquidationEngine(config.liquidation, publicClient, executor, risk, indexer);
  }

  logger.info(`Max slippage: ${config.maxSlippageBps / 100}%`);
  logger.info(`Retry attempts: ${config.retryConfig.maxAttempts}`);
  logger.info(`Transaction timeout: ${config.txReceiptTimeoutMs / 1000}s`);

  // Log initial balance
  await bot.logBalance();

  logger.info(`Polling every ${config.pollingIntervalMs / 1000}s...`);
  logger.info(
    config.vaultProcessingDelayMs > 0
      ? `Send throttle: ${config.vaultProcessingDelayMs / 1000}s between acquisitions`
      : "Send throttle: off (acquisitions are batched)"
  );
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

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
