import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, etc.)
collectDefaultMetrics({ register: registry });

// ============================================
// Custom Metrics
// ============================================

/**
 * Number of positions checked in the last poll
 */
export const positionsChecked = new Gauge({
  name: "liquidator_positions_checked",
  help: "Number of positions checked in the last poll",
  registers: [registry],
});

/**
 * Number of liquidatable positions found in the last poll
 */
export const positionsLiquidatable = new Gauge({
  name: "liquidator_positions_liquidatable",
  help: "Number of liquidatable positions found in the last poll",
  registers: [registry],
});

/**
 * Total successful liquidations
 */
export const liquidationsTotal = new Counter({
  name: "liquidator_liquidations_total",
  help: "Total number of successful liquidations",
  registers: [registry],
});

/**
 * Total failed liquidation attempts (tx reverted or receipt failed)
 */
export const liquidationsFailedTotal = new Counter({
  name: "liquidator_liquidations_failed_total",
  help: "Total number of failed liquidation attempts",
  registers: [registry],
});

/**
 * Total simulations that failed (position no longer valid)
 */
export const simulationsFailedTotal = new Counter({
  name: "liquidator_simulations_failed_total",
  help: "Total number of simulations that failed",
  registers: [registry],
});

/**
 * Total vaults seized from liquidations
 */
export const vaultsSeizedTotal = new Counter({
  name: "liquidator_vaults_seized_total",
  help: "Total number of vaults seized from liquidations",
  registers: [registry],
});

/**
 * Total vaults successfully swapped for WBTC
 */
export const vaultsSwappedTotal = new Counter({
  name: "liquidator_vaults_swapped_total",
  help: "Total number of vaults successfully swapped for WBTC",
  registers: [registry],
});

/**
 * Total WBTC received from vault swaps (in satoshis)
 */
export const wbtcReceivedTotal = new Counter({
  name: "liquidator_wbtc_received_total",
  help: "Total WBTC received from vault swaps (in satoshis)",
  registers: [registry],
});

/**
 * Total errors by type
 */
export const errorsTotal = new Counter({
  name: "liquidator_errors_total",
  help: "Total number of errors by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

/**
 * Duration of each poll cycle in seconds
 */
export const pollDurationSeconds = new Histogram({
  name: "liquidator_poll_duration_seconds",
  help: "Duration of each poll cycle in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Unix timestamp of the last poll
 */
export const lastPollTimestamp = new Gauge({
  name: "liquidator_last_poll_timestamp",
  help: "Unix timestamp of the last poll",
  registers: [registry],
});

/**
 * Token balance per token (debt tokens + WBTC)
 */
export const tokenBalance = new Gauge({
  name: "liquidator_token_balance",
  help: "Current token balance (debt tokens and WBTC)",
  labelNames: ["token", "address"] as const,
  registers: [registry],
});

// ============================================
// Metric Helper Functions
// ============================================

export function recordPositionsChecked(count: number): void {
  positionsChecked.set(count);
}

export function recordPositionsLiquidatable(count: number): void {
  positionsLiquidatable.set(count);
}

export function recordLiquidationSuccess(): void {
  liquidationsTotal.inc();
}

export function recordLiquidationFailed(): void {
  liquidationsFailedTotal.inc();
}

export function recordSimulationFailed(): void {
  simulationsFailedTotal.inc();
}

export function recordVaultsSeized(count: number): void {
  vaultsSeizedTotal.inc(count);
}

export function recordVaultSwapped(): void {
  vaultsSwappedTotal.inc();
}

export function recordWbtcReceived(satoshis: bigint): void {
  wbtcReceivedTotal.inc(Number(satoshis));
}

export function recordError(type: string): void {
  errorsTotal.inc({ type });
}

export function recordPollDuration(durationMs: number): void {
  pollDurationSeconds.observe(durationMs / 1000);
  lastPollTimestamp.set(Date.now() / 1000);
}

export function recordTokenBalance(
  token: string,
  address: string,
  balance: bigint,
  decimals: number
): void {
  tokenBalance.set({ token, address }, Number(balance) / 10 ** decimals);
}

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Get content type for Prometheus metrics
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
