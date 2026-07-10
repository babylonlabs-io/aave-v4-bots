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
  const server = startControlServer({ port: 0, host, handle, logger });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
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
