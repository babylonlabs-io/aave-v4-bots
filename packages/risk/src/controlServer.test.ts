import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlRoute } from "./control";
import { startControlServer } from "./controlServer";

// The kill switch's own socket. `createControlRoutes` is unit-tested in `control.test.ts`; this
// proves the server that carries it — that it binds where told, serves only its routes, and never
// leaks an internal error to a caller that may not even be authenticated.

const logger = { info: vi.fn(), warn: vi.fn() };
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.clearAllMocks();
});

const haltRoute: ControlRoute = (_req, res, pathname, searchParams) => {
  if (pathname !== "/halt") return false;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ state: "HALTED", reason: searchParams.get("reason") }));
  return true;
};

async function start(handle: ControlRoute, host = "127.0.0.1"): Promise<string> {
  const server = await startControlServer({ port: 0, host, handle, logger });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("startControlServer", () => {
  it("invokes an injected route and lets it answer", async () => {
    const res = await fetch(`${await start(haltRoute)}/halt`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "HALTED" });
  });

  it("passes the parsed pathname and query to the route", async () => {
    const res = await fetch(`${await start(haltRoute)}/halt?reason=incident+42`, {
      method: "POST",
    });
    expect(await res.json()).toMatchObject({ reason: "incident 42" });
  });

  it("404s a path no route claims, and never serves /metrics", async () => {
    const base = await start(haltRoute);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("404s when the handler declines the request", async () => {
    const declined = vi.fn<ControlRoute>(() => false);
    const base = await start(declined);

    expect((await fetch(`${base}/anything`)).status).toBe(404);
    expect(declined).toHaveBeenCalled();
  });

  // A throwing route must not take the process down or leak internals to an unauthenticated caller.
  it("returns 500 when a route throws, without leaking the error", async () => {
    const boom: ControlRoute = () => {
      throw new Error("secret internal detail");
    };

    const res = await fetch(`${await start(boom)}/halt`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret internal detail");
  });

  // Loopback is the default an operator gets; binding wide is opt-in and must be loud.
  it("warns when bound to 0.0.0.0", async () => {
    await start(haltRoute, "0.0.0.0");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("0.0.0.0"));
  });
});

// A kill switch that is configured but not listening is worse than one that is absent: the operator
// asked for it, the boot logs say nothing that stands out, and the bot trades believing `/halt` is
// there. Binding is therefore part of starting, and a failure to bind fails the boot.
describe("startControlServer — when it cannot bind", () => {
  it("rejects rather than handing back a server that never listens", async () => {
    // An address on no interface of this machine: EADDRNOTAVAIL, the ordinary container mistake of
    // pointing RISK_CONTROL_HOST at an address that is not in this network namespace.
    await expect(
      startControlServer({ port: 0, host: "203.0.113.7", handle: haltRoute, logger })
    ).rejects.toThrow(/could not bind 203\.0\.113\.7/);
  });

  // The failure has to say which setting produced it. A bare "listen failed" sends an operator
  // looking at the bot before the two environment variables that actually caused it.
  it("names the settings to fix and keeps the original error as its cause", async () => {
    const error = await startControlServer({
      port: 0,
      host: "203.0.113.7",
      handle: haltRoute,
      logger,
    }).then(
      () => new Error("expected the bind to fail"),
      (e: Error) => e
    );

    expect(error.message).toMatch(/RISK_CONTROL_HOST/);
    expect(error.message).toMatch(/RISK_CONTROL_PORT/);
    expect((error.cause as NodeJS.ErrnoException).code).toBeDefined();
  });

  // The one bind failure that was already fatal — it must stay fatal, and now as a rejection the
  // caller can act on rather than a `process.exit` from inside a library.
  it("rejects on an address already in use", async () => {
    const first = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      handle: haltRoute,
      logger,
    });
    servers.push(first);
    const { port } = first.address() as AddressInfo;

    await expect(
      startControlServer({ port, host: "127.0.0.1", handle: haltRoute, logger })
    ).rejects.toThrow(/EADDRINUSE/);
  });

  // The same event on a live server means a socket fault, not a missing kill switch. Exiting there
  // would let anyone who can reach the port stop the bot with a connection reset.
  it("logs, and keeps serving, an error raised after it is listening", async () => {
    const base = await start(haltRoute);
    const server = servers[servers.length - 1] as unknown as import("node:http").Server;

    server.emit("error", Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));

    expect(logger.warn).toHaveBeenCalledWith("[Control] Server error:", expect.any(Error));
    expect((await fetch(`${base}/halt`, { method: "POST" })).status).toBe(200);
  });
});
