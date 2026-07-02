import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { PublicClient } from "viem";

import { createLogger } from "@repo/logger";
import { type HealthCheckDependencies, runHealthChecks } from "./health";

const logger = createLogger();

export interface ObservabilityServerConfig {
  port: number;
  ponderUrl: string;
  ponderHealthEndpoint: string;
  getMetrics: () => Promise<string>;
  getMetricsContentType: () => string;
}

const healthCheckDeps: HealthCheckDependencies = {
  ponderUrl: "",
  ponderHealthEndpoint: "",
  publicClient: null,
};

/**
 * Update the public client reference for health checks
 */
export function setPublicClient(client: PublicClient): void {
  healthCheckDeps.publicClient = client;
}

/**
 * Start the metrics and health check HTTP server
 */
export function startObservabilityServer(config: ObservabilityServerConfig): void {
  healthCheckDeps.ponderUrl = config.ponderUrl;
  healthCheckDeps.ponderHealthEndpoint = config.ponderHealthEndpoint;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    try {
      if (url === "/health" || url === "/healthz") {
        const health = await runHealthChecks(healthCheckDeps);

        const statusCode =
          health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503;

        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health, null, 2));
      } else if (url === "/metrics") {
        const metrics = await config.getMetrics();
        res.writeHead(200, { "Content-Type": config.getMetricsContentType() });
        res.end(metrics);
      } else if (url === "/ready" || url === "/readyz") {
        const health = await runHealthChecks(healthCheckDeps);

        if (health.ponderReachable && health.rpcReachable) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: true }));
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, ...health }));
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      logger.error("[Observability] Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(config.port, () => {
    logger.info(`[Observability] Listening on port ${config.port}`);
    logger.info("[Observability]   /health  - Health check endpoint");
    logger.info("[Observability]   /metrics - Prometheus metrics");
    logger.info("[Observability]   /ready   - Readiness probe");
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error(
        `[Observability] Failed to bind to port ${config.port}: address already in use.`
      );
      process.exit(1);
    }
    logger.error("[Observability] Server error:", error);
  });
}
