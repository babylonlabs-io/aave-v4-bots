import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import type { ControlRoute } from "./control";

/**
 * The kill switch's own HTTP server.
 *
 * It lives in `risk` because `risk` owns the remote kill switch — `observability` owns logs,
 * metrics and health, and must not learn what `/halt` means. It is a *separate socket* from the
 * metrics server on purpose: `/metrics` wants to be scrapeable from the cluster, while an endpoint
 * that can stop production trading wants to be reachable by an operator and nobody else. Those are
 * different exposure decisions, so they get different sockets. Bearer auth still guards every
 * route — this is defence in depth, not a replacement for it.
 */
export interface ControlServerConfig {
  port: number;
  /** Interface to bind. Loopback unless you have a network policy that says otherwise. */
  host: string;
  routes: readonly ControlRoute[];
  /** Banner lines for the startup log. */
  routeNames?: readonly string[];
  /** Structural logger, so `@repo/risk` keeps its zero dependencies. */
  logger: { info(msg: string): void; warn(msg: string, ...rest: unknown[]): void };
}

export function startControlServer(config: ControlServerConfig): Server {
  const { port, host, routes, routeNames, logger } = config;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = new URL(req.url || "/", "http://localhost");

    try {
      for (const route of routes) {
        if (route(req, res, pathname, searchParams)) return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      // Never leak an internal error to a caller that may not even be authenticated.
      logger.warn("[Control] Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(port, host, () => {
    logger.info(`[Control] Kill switch listening on ${host}:${port}`);
    for (const name of routeNames ?? []) logger.info(`[Control]   ${name}`);
    if (host === "0.0.0.0") {
      logger.warn(
        "[Control] Bound to 0.0.0.0 — the kill switch is reachable from every network this " +
          "process can see. Restrict it with RISK_CONTROL_HOST unless a network policy covers it."
      );
    }
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.warn(`[Control] Failed to bind ${host}:${port}: address already in use.`);
      process.exit(1);
    }
    logger.warn("[Control] Server error:", error);
  });

  return server;
}
