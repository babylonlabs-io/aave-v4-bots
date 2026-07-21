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
