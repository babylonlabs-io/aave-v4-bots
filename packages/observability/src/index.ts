// Health check utilities
export {
  type HealthCheckResult,
  type HealthCheckDependencies,
  updateLastPollTime,
  getLastPollTime,
  runHealthChecks,
} from "./health";

// Metrics + health HTTP server. The kill switch is NOT here — `@repo/risk` owns it and serves it
// on its own socket (see `startRiskRuntime`).
export { type ObservabilityServerConfig, startObservabilityServer } from "./server";

// Prom-client adapters for the engine metric ports, and the shared registry they register into —
// what the server above serves on `/metrics`.
export {
  type MetricsRegistry,
  createMetricsRegistry,
  createLiquidationMetrics,
  createArbitrageMetrics,
  createIndexerMetrics,
} from "./metrics";
