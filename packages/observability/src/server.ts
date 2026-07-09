import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { PublicClient } from "viem";

import { createLogger } from "@repo/logger";
import { type HealthCheckDependencies, runHealthChecks } from "./health";

const logger = createLogger();

/**
 * An extra route, tried before the built-in ones. Returns `true` if it handled the request.
 *
 * This is how a capability package mounts its own HTTP surface without observability having to
 * know what it is: `@repo/risk` supplies the kill-switch routes this way (the module map puts
 * the remote kill switch in `risk` and keeps `observability` to logs/metrics/health).
 */
export type HttpRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
) => boolean;

export interface ObservabilityServerConfig {
  port: number;
  ponderUrl: string;
  ponderHealthEndpoint: string;
  getMetrics: () => Promise<string>;
  getMetricsContentType: () => string;
  /** Extra routes (e.g. `@repo/risk`'s kill-switch), tried before the built-in ones. */
  routes?: readonly HttpRoute[];
  /** Names of the extra routes, for the startup banner only. */
  routeNames?: readonly string[];
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
    // Parse rather than string-compare `req.url`, so `/metrics?foo=1` still routes and the
    // control endpoints can read their `?reason=`. The base is a placeholder; only the path
    // and query are used.
    const { pathname, searchParams } = new URL(req.url || "/", "http://localhost");
    const url = pathname;

    try {
      for (const route of config.routes ?? []) {
        if (route(req, res, pathname, searchParams)) return;
      }
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
    for (const name of config.routeNames ?? []) {
      logger.info(`[Observability]   ${name}`);
    }
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
