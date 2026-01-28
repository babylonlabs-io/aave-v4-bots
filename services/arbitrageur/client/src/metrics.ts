import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, etc.)
collectDefaultMetrics({ register: registry });

// ============================================
// Custom Metrics
// ============================================

/**
 * Total number of vaults successfully acquired
 */
export const vaultsAcquiredTotal = new Counter({
  name: "arbitrageur_vaults_acquired_total",
  help: "Total number of vaults successfully acquired",
  registers: [registry],
});

/**
 * Total WBTC spent acquiring vaults (in satoshis)
 */
export const wbtcSpentTotal = new Counter({
  name: "arbitrageur_wbtc_spent_total",
  help: "Total WBTC spent acquiring vaults (in satoshis)",
  registers: [registry],
});

/**
 * Total number of errors by type
 */
export const errorsTotal = new Counter({
  name: "arbitrageur_errors_total",
  help: "Total number of errors by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

/**
 * Duration of each poll cycle in seconds
 */
export const pollDurationSeconds = new Histogram({
  name: "arbitrageur_poll_duration_seconds",
  help: "Duration of each poll cycle in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Timestamp of the last successful poll
 */
export const lastPollTimestamp = new Gauge({
  name: "arbitrageur_last_poll_timestamp",
  help: "Unix timestamp of the last successful poll",
  registers: [registry],
});

/**
 * Current WBTC balance of the arbitrageur (in satoshis)
 */
export const wbtcBalance = new Gauge({
  name: "arbitrageur_wbtc_balance",
  help: "Current WBTC balance of the arbitrageur (in satoshis)",
  registers: [registry],
});

// ============================================
// Metric Helper Functions
// ============================================

export function recordVaultAcquired(wbtcPaidSatoshis: bigint): void {
  vaultsAcquiredTotal.inc();
  wbtcSpentTotal.inc(Number(wbtcPaidSatoshis));
}

export function recordError(type: string): void {
  errorsTotal.inc({ type });
}

export function recordPollDuration(durationMs: number): void {
  pollDurationSeconds.observe(durationMs / 1000);
  lastPollTimestamp.set(Date.now() / 1000);
}

export function recordWbtcBalance(balanceSatoshis: bigint): void {
  wbtcBalance.set(Number(balanceSatoshis));
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
