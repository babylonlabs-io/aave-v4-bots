import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.arbitrageur from root directory BEFORE importing config
dotenvConfig({ path: resolve(process.cwd(), ".env.arbitrageur") });

import type { PublicClient } from "viem";

import { type Executor, LiquidationEngine } from "@repo/engine";
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
      ponderHealthEndpoint: "/escrowed-vaults",
      getMetrics,
      getMetricsContentType,
    },
  });

  const bot = new ArbitrageurBot({
    risk,
    publicClient,
    executor,
    vaultSwapAddress: config.vaultSwapAddress,
    wbtcAddress: config.wbtcAddress,
    vaultKeeperAddress: config.vaultKeeperAddress,
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
  return { bot, publicClient, executor, risk };
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
  risk: RiskGate
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
  });

  liqLogger.info(`Liquidation engine enabled (execution: ${executor.mode})`);
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

  const { bot, publicClient, executor, risk } = await createBot(config);

  // Opt-in: also run the liquidation engine (both engines, one process) — sharing the one
  // nonce allocator so the two engines' concurrent sends never collide on the signer.
  if (config.liquidation) {
    await startLiquidationEngine(config.liquidation, publicClient, executor, risk);
  }

  logger.info(`Max slippage: ${config.maxSlippageBps / 100}%`);
  logger.info(`Retry attempts: ${config.retryMaxAttempts}`);
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
