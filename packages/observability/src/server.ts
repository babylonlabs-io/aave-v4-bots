import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { PublicClient } from "viem";

import { createLogger } from "@repo/logger";
import { type HealthCheckDependencies, runHealthChecks } from "./health";

const logger = createLogger();

// Metrics + health only. The kill switch lives in `@repo/risk` on its own socket — a route that
// can stop trading must never share an exposure decision with a Prometheus scrape target.

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
 * Start the metrics and health check HTTP server. Returns the `Server` so a caller can close it
 * (and so tests can bind an ephemeral port).
 */
export function startObservabilityServer(config: ObservabilityServerConfig): Server {
  healthCheckDeps.ponderUrl = config.ponderUrl;
  healthCheckDeps.ponderHealthEndpoint = config.ponderHealthEndpoint;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Parse rather than string-compare `req.url`, so `/metrics?foo=1` still routes. The base is a
    // placeholder; only the path is used.
    const { pathname } = new URL(req.url || "/", "http://localhost");
    const url = pathname;

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

  return serverWithErrorHandler(server, config.port);
}

function serverWithErrorHandler(server: Server, port: number): Server {
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error(`[Observability] Failed to bind to port ${port}: address already in use.`);
      process.exit(1);
    }
    logger.error("[Observability] Server error:", error);
  });
  return server;
}
