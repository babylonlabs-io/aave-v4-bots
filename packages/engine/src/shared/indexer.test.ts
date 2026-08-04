import { createRiskGate } from "@repo/risk";
import { describe, expect, it, vi } from "vitest";
import { assessIndexerLag, createIndexer, selectChainStatus } from "./indexer";

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noMetrics = () => ({
  recordLag: vi.fn(),
  recordCycleSkipped: vi.fn(),
  recordHalt: vi.fn(),
});

describe("selectChainStatus", () => {
  const body = {
    mainnet: { id: 1, block: { number: 100, timestamp: 1_700_000_000 } },
    sepolia: { id: 11_155_111, block: { number: 50, timestamp: 1_700_000_500 } },
  };

  it("matches on chain id, not the config-supplied name", () => {
    expect(selectChainStatus(body, 11_155_111)).toEqual({
      blockNumber: 50n,
      blockTimestampMs: 1_700_000_500_000,
    });
  });

  it("returns undefined for a chain that has not been indexed yet", () => {
    // A real state during backfill, and distinct from a failed read — the caller treats them the
    // same, but only because both mean "do not trade", not because they are the same thing.
    expect(selectChainStatus(body, 31_337)).toBeUndefined();
  });

  it("refuses to guess between duplicate entries for one chain", () => {
    expect(() =>
      selectChainStatus(
        { a: body.mainnet, b: { ...body.mainnet, block: { number: 9, timestamp: 1 } } },
        1
      )
    ).toThrow(/2 entries for chain 1/);
  });
});

describe("assessIndexerLag", () => {
  const status = { blockNumber: 100n, blockTimestampMs: 0 };

  it("passes when within the bound", () => {
    expect(assessIndexerLag(status, 105n, 10n)).toEqual({ kind: "ok", lagBlocks: 5n });
  });

  it("is inclusive at the bound", () => {
    expect(assessIndexerLag(status, 110n, 10n).kind).toBe("ok");
  });

  it("flags lag beyond the bound", () => {
    const verdict = assessIndexerLag(status, 111n, 10n);
    expect(verdict.kind).toBe("lagging");
    if (verdict.kind !== "lagging") throw new Error("expected lagging");
    expect(verdict.lagBlocks).toBe(11n);
  });

  it("clamps an indexer ahead of our RPC to zero rather than reporting negative lag", () => {
    // Our RPC can trail the indexer's between reads; that is not lag.
    expect(assessIndexerLag(status, 90n, 10n)).toEqual({ kind: "ok", lagBlocks: 0n });
  });

  it("reports unknown when the chain is absent", () => {
    expect(assessIndexerLag(undefined, 100n, 10n).kind).toBe("unknown");
  });
});

describe("createIndexer", () => {
  const guard = (opts: {
    fetchStatus: typeof globalThis.fetch;
    maxLagBlocks?: bigint;
    haltAfterMs?: number;
    risk?: ReturnType<typeof createRiskGate>;
    metrics?: ReturnType<typeof noMetrics>;
  }) => {
    vi.stubGlobal("fetch", opts.fetchStatus);
    const risk = opts.risk ?? createRiskGate();
    const metrics = opts.metrics ?? noMetrics();
    const clock = { t: 0 };
    const health = createIndexer({
      baseUrl: "http://indexer",
      retry: { maxAttempts: 1 },
      chainId: 1,
      getRpcHead: async () => 1_000n,
      risk,
      logger: silentLogger,
      metrics,
      now: () => clock.t,
      config: {
        // `in` rather than `??`: an explicitly-undefined bound is the "guard off" case.
        maxLagBlocks: "maxLagBlocks" in opts ? opts.maxLagBlocks : 10n,
        haltAfterMs: opts.haltAfterMs ?? 60_000,
      },
    });
    return { health, risk, metrics, clock };
  };

  const statusAt = (block: number) =>
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ mainnet: { id: 1, block: { number: block, timestamp: 0 } } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
    ) as unknown as typeof globalThis.fetch;

  it("is a complete no-op when the guard is unconfigured", async () => {
    const fetchStatus = vi.fn() as unknown as typeof globalThis.fetch;
    const { health } = guard({ fetchStatus, maxLagBlocks: undefined });

    await expect(health.ok()).resolves.toBe(true);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("allows a cycle when the indexer is current", async () => {
    const { health, metrics } = guard({ fetchStatus: statusAt(995) });

    await expect(health.ok()).resolves.toBe(true);
    expect(metrics.recordLag).toHaveBeenCalledWith(5);
    expect(metrics.recordCycleSkipped).not.toHaveBeenCalled();
  });

  it("skips the cycle when lagging, without halting on the first bad check", async () => {
    const { health, risk, metrics } = guard({ fetchStatus: statusAt(500) });

    await expect(health.ok()).resolves.toBe(false);
    expect(metrics.recordCycleSkipped).toHaveBeenCalledTimes(1);
    // Catching up after a reorg is transient; one bad check must not stop production.
    expect(risk.state()).toBe("RUNNING");
  });

  it("halts once the indexer has been unusable for the configured duration", async () => {
    const { health, risk, metrics, clock } = guard({
      fetchStatus: statusAt(500),
      haltAfterMs: 60_000,
    });

    await health.ok();
    clock.t = 59_000;
    await health.ok();
    expect(risk.state()).toBe("RUNNING");

    clock.t = 60_000;
    await health.ok();
    expect(risk.state()).toBe("HALTED");
    expect(metrics.recordHalt).toHaveBeenCalledTimes(1);
  });

  it("does NOT halt on call volume alone — the threshold is elapsed time", async () => {
    // A *count* of bad checks would make the threshold depend on how many engines poll and how
    // fast: the arbitrageur's two loops tick at different intervals against one indexer, so the
    // same config would mean something different in every deployment. 50 checks inside the window
    // must not halt.
    const { health, risk } = guard({ fetchStatus: statusAt(500), haltAfterMs: 60_000 });

    for (let i = 0; i < 50; i++) await health.ok();

    expect(risk.state()).toBe("RUNNING");
  });

  it("halts only once for a single sustained incident", async () => {
    // Otherwise `indexer_halts_total` counts one incident many times and the warning repeats every
    // cycle for as long as it lasts.
    const { health, risk, metrics, clock } = guard({ fetchStatus: statusAt(500), haltAfterMs: 10 });

    await health.ok(); // t=0 — starts the streak
    clock.t = 100; // well past the threshold
    await health.ok(); // halts
    await health.ok(); // still broken, but already halted
    await health.ok();

    expect(risk.state()).toBe("HALTED");
    expect(metrics.recordHalt).toHaveBeenCalledTimes(1);
  });

  it("restarts the clock after the indexer recovers", async () => {
    let block = 500;
    const fetchStatus = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ mainnet: { id: 1, block: { number: block, timestamp: 0 } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof globalThis.fetch;
    const { health, risk, clock } = guard({ fetchStatus, haltAfterMs: 60_000 });

    await health.ok();
    clock.t = 50_000;
    block = 995; // caught up, well inside the window
    await health.ok();
    block = 500; // lagging again — a *new* incident, so the clock restarts
    await health.ok();
    clock.t = 100_000;
    await health.ok();

    // 100s of wall clock, but never 60s of *continuous* trouble.
    expect(risk.state()).toBe("RUNNING");
  });

  it("treats an unreadable status as bad, not as zero lag", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const { health, metrics } = guard({ fetchStatus });

    await expect(health.ok()).resolves.toBe(false);
    expect(metrics.recordCycleSkipped).toHaveBeenCalledTimes(1);
  });

  it("shares one incident clock across engines, so interleaved loops halt at one wall-clock time", async () => {
    // The arbitrageur polls one indexer from two loops at different intervals. Both must observe a
    // single streak: interleaving them changes how often the streak is *observed*, never when the
    // halt fires. Two separate guards would each start their own clock.
    const { health, risk, clock } = guard({ fetchStatus: statusAt(500), haltAfterMs: 60_000 });

    await health.ok(); // arb, t=0 — starts the streak
    clock.t = 12_000;
    await health.ok(); // liq
    clock.t = 24_000;
    await health.ok(); // liq
    clock.t = 30_000;
    await health.ok(); // arb
    expect(risk.state()).toBe("RUNNING");

    clock.t = 60_000;
    await health.ok(); // whichever loop gets there first
    expect(risk.state()).toBe("HALTED");
  });
});
