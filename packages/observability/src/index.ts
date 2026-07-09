// Health check utilities
export {
  type HealthCheckResult,
  type HealthCheckDependencies,
  updateLastPollTime,
  getLastPollTime,
  runHealthChecks,
} from "./health";

// Metrics + health HTTP server. Other capability packages mount their own routes through
// `HttpRoute` (see `@repo/risk`'s kill switch) rather than this package knowing about them.
export {
  type HttpRoute,
  type ObservabilityServerConfig,
  setPublicClient,
  startObservabilityServer,
} from "./server";
