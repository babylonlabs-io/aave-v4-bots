// Re-export health utilities from the observability package
export {
  type HealthCheckResult,
  type HealthCheckDependencies,
  updateLastPollTime,
  getLastPollTime,
  runHealthChecks,
} from "@repo/observability";
