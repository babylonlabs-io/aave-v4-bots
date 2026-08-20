import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startObservabilityServer } from "./server";

// The metrics server, over a real socket. The property that matters most here is a negative one:
// it serves metrics and health, and it *cannot* serve the kill switch — that lives in
// `@repo/risk` on its own socket, so the two never share an exposure decision.

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listening(host?: string) {
  const server = startObservabilityServer({
    port: 0, // ephemeral — never collide with a real metrics port in CI
    ...(host === undefined ? {} : { host }),
    ponderUrl: "http://127.0.0.1:1",
    ponderHealthEndpoint: "/positions",
    getMetrics: async () => "bot_up 1",
    getMetricsContentType: () => "text/plain",
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return server.address() as AddressInfo;
}

async function metricsServer(): Promise<string> {
  return `http://127.0.0.1:${(await listening()).port}`;
}

describe("startObservabilityServer", () => {
  it("serves /metrics", async () => {
    const res = await fetch(`${await metricsServer()}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bot_up 1");
  });

  it("serves /metrics with a query string", async () => {
    expect((await fetch(`${await metricsServer()}/metrics?foo=1`)).status).toBe(200);
  });

  // Which interfaces can reach an unauthenticated `/metrics` is a deployment decision, and the
  // gauges it serves carry the signer and treasury addresses with their live balances — so the
  // host has to be something an operator can actually set, not just something we log.
  describe("bind host", () => {
    it("binds every interface when none is configured — what it has always done", async () => {
      expect((await listening()).address).toBe("::");
    });

    it("binds only the configured interface", async () => {
      expect((await listening("127.0.0.1")).address).toBe("127.0.0.1");
    });

    it("still serves metrics there", async () => {
      const { port } = await listening("127.0.0.1");
      expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(200);
    });
  });

  // No configuration of this server can expose a route that stops trading.
  it.each(["/halt", "/resume", "/status"])("404s %s — it has no control plane", async (path) => {
    const res = await fetch(`${await metricsServer()}${path}`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
