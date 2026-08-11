import type { RiskSlot } from "@repo/risk";
import { createRiskGate } from "@repo/risk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseEngine, type BaseEngineConfig, type CycleMetrics } from "./engine";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * Both engines run their cycle through `BaseEngine.run()`, so these assertions are the contract for
 * both of them — which is the point of the class existing. Pinning the same ordering across two
 * hand-written `run()` methods would have meant asserting on source text.
 */
class TestEngine extends BaseEngine<CycleMetrics> {
  readonly calls: string[] = [];
  constructor(
    config: BaseEngineConfig<CycleMetrics>,
    private body: (self: TestEngine, slots: RiskSlot[]) => Promise<void>
  ) {
    super(config, { engine: "test", intentAction: "test-action" });
  }
  protected async poll(slots: RiskSlot[]): Promise<void> {
    this.calls.push("poll");
    await this.body(this, slots);
  }
  /** Reaching `this.risk` is what `protected` is for — a real strategy opens its slots this way. */
  openTestSlot(): RiskSlot {
    return this.risk.openSlot({ kind: "test", subject: "test" });
  }
}

function harness(
  opts: {
    indexerOk?: boolean;
    onReconcile?: () => void;
    body?: (self: TestEngine, slots: RiskSlot[]) => Promise<void>;
  } = {}
) {
  const reconciled: string[] = [];
  const risk = createRiskGate();
  const metrics = { recordError: vi.fn(), recordPollDuration: vi.fn() };
  const onPollComplete = vi.fn();
  const engine = new TestEngine(
    {
      publicClient: {} as BaseEngineConfig<CycleMetrics>["publicClient"],
      indexer: {
        ok: async () => opts.indexerOk ?? true,
      } as BaseEngineConfig<CycleMetrics>["indexer"],
      metrics,
      logger: silentLogger,
      risk,
      executor: {
        // `reconcile()` is the base's own, so this stub also pins the action it sweeps by.
        reconcile: async (action: string) => {
          engine.calls.push("reconcile");
          reconciled.push(action);
          opts.onReconcile?.();
        },
        resyncNonces: async () => {
          engine.calls.push("resyncNonces");
        },
      } as unknown as BaseEngineConfig<CycleMetrics>["executor"],
      onPollComplete,
    },
    opts.body ?? (async () => {})
  );
  return { engine, risk, metrics, onPollComplete, reconciled };
}

describe("BaseEngine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconciles and resyncs nonces before asking the indexer", async () => {
    const { engine, onPollComplete } = harness();

    await engine.run();

    // Load-bearing, not cosmetic: an action stranded as a live intent has to be resolved even in a
    // cycle the indexer guard goes on to skip, so reconcile cannot sit behind that guard.
    expect(engine.calls).toEqual(["reconcile", "resyncNonces", "poll"]);
    expect(onPollComplete).toHaveBeenCalledOnce();
  });

  // Reconcile is unscoped: an intent belongs to the signer, not to the engine that created it. The
  // engine used to name its own action here, which stranded any action no engine owns — `approval`
  // — leaving it live forever and making every later `ensureAllowance` a duplicate.
  it("sweeps every in-flight intent, not just its own action's", async () => {
    const { engine, reconciled } = harness();

    await engine.run();

    expect(reconciled).toEqual([undefined]);
  });

  it("skips everything but the bookkeeping when the gate is HALTED", async () => {
    const { engine, risk, metrics, onPollComplete } = harness();
    risk.halt("test");

    await engine.run();

    // Nothing is touched — not even reconcile — but the cycle still stamps itself, so a halted bot
    // reads as alive rather than wedged.
    expect(engine.calls).toEqual([]);
    expect(metrics.recordPollDuration).toHaveBeenCalledOnce();
    expect(onPollComplete).toHaveBeenCalledOnce();
  });

  it("runs the strategy only when the indexer says so", async () => {
    const { engine, onPollComplete } = harness({ indexerOk: false });

    await engine.run();

    expect(engine.calls).toEqual(["reconcile", "resyncNonces"]);
    expect(onPollComplete).toHaveBeenCalledOnce();
  });

  it("counts a thrown strategy as poll_error and keeps the loop alive", async () => {
    const { engine, metrics, onPollComplete } = harness({
      body: async () => {
        throw new Error("boom");
      },
    });

    await expect(engine.run()).resolves.toBeUndefined();

    expect(metrics.recordError.mock.calls).toEqual([["poll_error"]]);
    expect(metrics.recordPollDuration).toHaveBeenCalledOnce();
    expect(onPollComplete).toHaveBeenCalledOnce();
  });

  it("stamps the poll even when reconcile itself throws", async () => {
    const { engine, metrics, onPollComplete } = harness({
      onReconcile: () => {
        throw new Error("store down");
      },
    });

    await engine.run();

    expect(metrics.recordError.mock.calls).toEqual([["poll_error"]]);
    expect(onPollComplete).toHaveBeenCalledOnce();
  });

  it("releases every slot the strategy left unsettled, however the cycle ended", async () => {
    const { engine, risk } = harness({
      body: async (self, slots) => {
        slots.push(self.openTestSlot());
        throw new Error("boom");
      },
    });

    await engine.run();

    // A slot leaked here would permanently shrink the exposure cap for the life of the process.
    expect(risk.inFlight()).toBe(0);
  });
});
