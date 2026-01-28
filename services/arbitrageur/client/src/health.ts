// Re-export health utilities from shared package
export {
  type HealthCheckResult,
  type HealthCheckDependencies,
  updateLastPollTime,
  getLastPollTime,
  runHealthChecks,
} from "@repo/shared";
