import type { LiquidationMetrics } from "@repo/engine";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";

/**
 * Prom-client implementation of the `LiquidationEngine` metrics port. Registers
 * the `liquidator_*` metric set into `registry` and returns the port object the
 * engine reports through.
 */
export function createLiquidationMetrics(registry: Registry): LiquidationMetrics {
  const positionsChecked = new Gauge({
    name: "liquidator_positions_checked",
    help: "Number of positions checked in the last poll",
    registers: [registry],
  });

  const positionsLiquidatable = new Gauge({
    name: "liquidator_positions_liquidatable",
    help: "Number of liquidatable positions found in the last poll",
    registers: [registry],
  });

  const liquidationsTotal = new Counter({
    name: "liquidator_liquidations_total",
    help: "Total number of successful liquidations",
    registers: [registry],
  });

  const liquidationsFailedTotal = new Counter({
    name: "liquidator_liquidations_failed_total",
    help: "Total number of failed liquidation attempts",
    registers: [registry],
  });

  const simulationsFailedTotal = new Counter({
    name: "liquidator_simulations_failed_total",
    help: "Total number of simulations that failed",
    registers: [registry],
  });

  const errorsTotal = new Counter({
    name: "liquidator_errors_total",
    help: "Total number of errors by type",
    labelNames: ["type"] as const,
    registers: [registry],
  });

  const pollDurationSeconds = new Histogram({
    name: "liquidator_poll_duration_seconds",
    help: "Duration of each poll cycle in seconds",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  });

  const lastPollTimestamp = new Gauge({
    name: "liquidator_last_poll_timestamp",
    help: "Unix timestamp of the last poll",
    registers: [registry],
  });

  const tokenBalance = new Gauge({
    name: "liquidator_token_balance",
    help: "Current token balance (debt tokens and WBTC)",
    labelNames: ["token", "address"] as const,
    registers: [registry],
  });

  return {
    recordPositionsChecked(count) {
      positionsChecked.set(count);
    },
    recordPositionsLiquidatable(count) {
      positionsLiquidatable.set(count);
    },
    recordLiquidationSuccess() {
      liquidationsTotal.inc();
    },
    recordLiquidationFailed() {
      liquidationsFailedTotal.inc();
    },
    recordSimulationFailed() {
      simulationsFailedTotal.inc();
    },
    recordError(type) {
      errorsTotal.inc({ type });
    },
    recordPollDuration(durationMs) {
      pollDurationSeconds.observe(durationMs / 1000);
      lastPollTimestamp.set(Date.now() / 1000);
    },
    recordTokenBalance(symbol, address, balance, decimals) {
      tokenBalance.set({ token: symbol, address }, Number(balance) / 10 ** decimals);
    },
  };
}
