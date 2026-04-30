import { createPublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { instrumentedHttp } from "@repo/shared";

describe("instrumentedHttp", () => {
  it("invokes the observer once per JSON-RPC method call", async () => {
    const observer = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      // Minimal valid eth_chainId response so viem doesn't throw.
      const result =
        body.method === "eth_chainId" ? "0x1" : "0x0000000000000000000000000000000000000000";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Replace global fetch only for this test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = createPublicClient({
        transport: instrumentedHttp("http://localhost:8545", observer),
      });

      await client.getChainId();

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith("eth_chainId");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let observer errors break the RPC call", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = createPublicClient({
        transport: instrumentedHttp("http://localhost:8545", () => {
          throw new Error("metric system down");
        }),
      });

      await expect(client.getChainId()).resolves.toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
