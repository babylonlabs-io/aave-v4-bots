import { createPublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { instrumentedHttp } from "./instrumentedTransport";

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

  it("counts every method in a batched body", async () => {
    // viem batches several calls into one HTTP request; the provider still bills per method.
    const observer = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "[]") as { id: number; method: string }[];
      return new Response(
        JSON.stringify(body.map((call) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" }))),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = createPublicClient({
        transport: instrumentedHttp("http://localhost:8545", observer, { batch: true }),
      });

      // Two *distinct* methods: viem collapses identical concurrent calls, so repeating one would
      // prove nothing about batching.
      await Promise.all([client.getChainId(), client.getBlockNumber()]);

      expect(fetchMock).toHaveBeenCalledTimes(1); // one HTTP request...
      expect(observer.mock.calls.flat().sort()).toEqual(["eth_blockNumber", "eth_chainId"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("counts each retry attempt, not just the logical call", async () => {
    // The reason the observer hangs off `onFetchRequest`: the provider bills every attempt, so an
    // observer above viem's retry would under-report exactly during an incident.
    const observer = vi.fn();
    const fetchMock = vi.fn(async () => new Response("upstream is down", { status: 500 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = createPublicClient({
        transport: instrumentedHttp("http://localhost:8545", observer, {
          retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
        }),
      });

      await expect(client.getChainId()).rejects.toThrow();

      // `maxAttempts: 3` ⇒ viem `retryCount: 2` ⇒ 3 total attempts. Getting the off-by-one wrong
      // here is silent, which is why it is asserted rather than assumed.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(observer).toHaveBeenCalledTimes(3);
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
