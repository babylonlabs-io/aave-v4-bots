import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RiskGate } from "./types";

// The **remote kill switch** — an authenticated HTTP surface for tripping and clearing `HALTED`
// without a redeploy. It lives in `risk`, which owns the kill switch; `observability` owns
// logs/metrics/health and never learns that `/halt` exists. `startControlServer` (this package)
// serves these routes on their own socket.

export interface ControlRoutesConfig {
  /** The process's single risk gate — halting it stops every engine the process drives. */
  gate: RiskGate;
  /** Shared secret for `Authorization: Bearer <token>`. Resolve it with `resolveControlToken`. */
  token: string;
  /** Audit sink for halt/resume/rejection events. A callback, so `risk` needs no logger dep. */
  onEvent?: (message: string) => void;
}

/**
 * Resolve the control endpoint's bearer token from a secret *reference* (an env-var name, an AWS
 * secret id, …) via the caller's secrets provider — the token value never lives in `Config`.
 * Returns `undefined` when no ref is configured, leaving the kill switch unmounted.
 */
export async function resolveControlToken(
  tokenRef: string | undefined,
  getSecret: (ref: string) => Promise<string>
): Promise<string | undefined> {
  if (!tokenRef) return undefined;
  const token = await getSecret(tokenRef);
  // Fail closed: a blank token would authenticate every request.
  if (!token) throw new Error(`[risk] control secret "${tokenRef}" resolved to an empty token`);
  return token;
}

/**
 * Compare in constant time so a wrong token cannot be recovered byte-by-byte from response
 * latency. Unequal lengths short-circuit (`timingSafeEqual` throws on them); that leaks only the
 * token's length, which is not secret.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length), expected);
}

/**
 * The `?reason=` is operator-supplied free text that lands in logs and in the response. Strip
 * control characters (a newline would let a caller forge log lines) and bound the length.
 */
function sanitizeReason(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 200)
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The paths this route claims, for the control server's startup banner. */
export const CONTROL_ROUTE_NAMES = [
  "/status  - Kill-switch state (authenticated)",
  "/halt    - Trip the kill-switch (POST, authenticated)",
  "/resume  - Clear the kill-switch (POST, authenticated)",
] as const;

/** One HTTP route: returns `true` if it handled the request, `false` to fall through. */
export type ControlRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
) => boolean;

/**
 * Build the kill-switch route: `POST /halt`, `POST /resume`, `GET /status`. Returns `false` for
 * any other path, so the server falls through to a 404.
 */
export function createControlRoutes(config: ControlRoutesConfig): ControlRoute {
  const { gate, token, onEvent } = config;

  return (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    searchParams: URLSearchParams
  ): boolean => {
    if (pathname !== "/halt" && pathname !== "/resume" && pathname !== "/status") return false;

    // `pathname` has been through WHATWG URL normalization, which collapses dot segments:
    // `/foo/../halt` and `/%2e%2e/halt` both arrive here as `/halt`. Bearer auth still applies,
    // but a reverse proxy whose ACL blocks the literal `/halt` would forward those unchanged.
    // Only serve a control route when the client asked for it *literally*.
    const rawPath = (req.url || "/").split("?")[0];
    if (rawPath !== pathname) return false;

    if (!authorize(req, token)) {
      // Never echo what was supplied — an error message is an oracle.
      onEvent?.(`Rejected unauthenticated ${req.method} ${pathname}`);
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    if (pathname === "/status") {
      if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return true;
      }
      json(res, 200, { state: gate.state(), inFlight: gate.inFlight() });
      return true;
    }

    // /halt and /resume mutate — never allow them on GET, where a browser preload or a link
    // click could trigger them.
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }

    if (pathname === "/halt") {
      const supplied = searchParams.get("reason");
      const reason = (supplied && sanitizeReason(supplied)) || "manual halt via control endpoint";
      gate.halt(reason);
      onEvent?.(`HALTED: ${reason}`);
      json(res, 200, { state: gate.state(), reason });
      return true;
    }

    gate.resume();
    onEvent?.("RESUMED via control endpoint");
    json(res, 200, { state: gate.state() });
    return true;
  };
}
