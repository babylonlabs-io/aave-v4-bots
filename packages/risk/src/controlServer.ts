import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { CONTROL_ROUTE_NAMES, type ControlRoute } from "./control";

/**
 * The kill switch's own HTTP server.
 *
 * It lives in `risk` because `risk` owns the remote kill switch — `observability` owns logs,
 * metrics and health, and must not learn what `/halt` means. It is a *separate socket* on purpose:
 * `/metrics` wants to be scrapeable from the cluster, while an endpoint that can stop production
 * trading wants to be reachable by an operator and nobody else. Those are different exposure
 * decisions, so they get different sockets. Bearer auth still guards the handler — this is defence
 * in depth, not a replacement for it.
 */
export interface ControlServerConfig {
  port: number;
  /** Interface to bind. Loopback unless you have a network policy that says otherwise. */
  host: string;
  /** The control handler, from `createControlRoutes`. Anything it declines 404s. */
  handle: ControlRoute;
  /** Structural logger, so `@repo/risk` keeps its zero dependencies. */
  logger: { info(msg: string): void; warn(msg: string, ...rest: unknown[]): void };
}

/**
 * Start the kill switch, resolving only once it is actually listening.
 *
 * Asynchronous because "configured" has to mean "reachable". A bind that fails arrives on the
 * `error` event *after* `listen` returns, so a synchronous start hands back a server that may never
 * accept a connection — and the caller, having asked for a kill switch and received one, boots and
 * trades. The operator's only warning would be the absence of one log line among the boot noise.
 *
 * So a pre-`listening` error rejects, and boot fails with it. That is the same stance the rest of
 * the configuration takes: a safety control the operator asked for and cannot have is a reason not
 * to start, not a reason to warn. `EADDRINUSE` is the common one, but `EACCES` (a privileged port
 * as an unprivileged user) and `EADDRNOTAVAIL` (a host that is not on this machine — an ordinary
 * container mistake) fail exactly as silently and matter exactly as much.
 *
 * After a successful bind the same event means something else entirely — a socket-level fault on a
 * live server — and is logged, never fatal. Taking the process down there would let anyone who can
 * reach the port stop the bot by resetting a connection.
 */
export function startControlServer(config: ControlServerConfig): Promise<Server> {
  const { port, host, handle, logger } = config;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = new URL(req.url || "/", "http://localhost");

    try {
      if (handle(req, res, pathname, searchParams)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      // Never leak an internal error to a caller that may not even be authenticated.
      logger.warn("[Control] Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  return new Promise<Server>((resolve, reject) => {
    let bound = false;

    server.listen(port, host, () => {
      bound = true;
      logger.info(`[Control] Kill switch listening on ${host}:${port}`);
      for (const name of CONTROL_ROUTE_NAMES) logger.info(`[Control]   ${name}`);
      if (host === "0.0.0.0") {
        logger.warn(
          "[Control] Bound to 0.0.0.0 — the kill switch is reachable from every network this " +
            "process can see. Restrict it with RISK_CONTROL_HOST unless a network policy covers it."
        );
      }
      resolve(server);
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (bound) {
        // A live server's socket fault. Log it: the switch is still listening, and exiting here
        // would hand anyone who can reach the port a way to stop the bot with a connection reset.
        logger.warn("[Control] Server error:", error);
        return;
      }
      reject(
        new Error(
          `the kill switch could not bind ${host}:${port} (${error.code ?? error.message}) — refusing to trade without the control endpoint RISK_CONTROL_TOKEN_REF asked for. Check RISK_CONTROL_HOST is an address on this machine and RISK_CONTROL_PORT is free and unprivileged.`,
          { cause: error }
        )
      );
    });
  });
}
