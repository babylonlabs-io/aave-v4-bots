import { describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "./indexerClient";

const client = () => createIndexerClient({ baseUrl: "http://indexer", retry: { maxAttempts: 1 } });

describe("read", () => {
  it("applies the base URL and returns the decoded body", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ total: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().read<{ total: number }>("/liquidatable-positions")).resolves.toEqual({
      total: 7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://indexer/liquidatable-positions",
      expect.anything()
    );
  });
});

describe("probeReady", () => {
  it("is false for 503 and does NOT retry it", async () => {
    // Ponder answers 503 for as long as it is backfilling. Retrying that would turn the expected
    // answer into a backoff loop, which is why readiness is not a `read`.
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().probeReady()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is true for 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );
    await expect(client().probeReady()).resolves.toBe(true);
  });
});

describe("waitUntilReady", () => {
  const ready = (statuses: number[]) => {
    let i = 0;
    return vi.fn(
      async () => new Response("", { status: statuses[Math.min(i++, statuses.length - 1)] })
    ) as unknown as typeof globalThis.fetch;
  };

  it("returns once the indexer reports ready", async () => {
    vi.stubGlobal("fetch", ready([503, 503, 200]));
    await expect(
      client().waitUntilReady({
        timeoutMs: 10_000,
        pollIntervalMs: 1,
        sleep: async () => {},
      })
    ).resolves.toBe(true);
  });

  it("shrinks the probe's own timeout to what is left of the budget", async () => {
    // Clamping only the sleep is not enough: a `/ready` that never answers would otherwise burn a
    // full poll interval past the deadline. Asserted on the abort budget the client asks for,
    // because that is the thing that bounds a hanging request.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );

    let clock = 0;
    await expect(
      client().waitUntilReady({
        timeoutMs: 50, // less than one poll interval
        pollIntervalMs: 2_000,
        now: () => clock,
        sleep: async () => {
          clock += 60;
        },
      })
    ).resolves.toBe(false);

    // 50ms of budget left, not the 2000ms poll interval.
    expect(timeoutSpy).toHaveBeenCalledWith(50);
    expect(timeoutSpy).not.toHaveBeenCalledWith(2_000);
    timeoutSpy.mockRestore();
  });

  it("gives up at the deadline rather than waiting forever", async () => {
    vi.stubGlobal("fetch", ready([503]));
    let clock = 0;
    await expect(
      client().waitUntilReady({
        timeoutMs: 50,
        pollIntervalMs: 1,
        now: () => clock,
        sleep: async () => {
          clock += 25;
        },
      })
    ).resolves.toBe(false);
  });

  it("treats an unreachable indexer as not-ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    let clock = 0;
    await expect(
      client().waitUntilReady({
        timeoutMs: 10,
        pollIntervalMs: 1,
        now: () => clock,
        sleep: async () => {
          clock += 20;
        },
      })
    ).resolves.toBe(false);
  });
});
