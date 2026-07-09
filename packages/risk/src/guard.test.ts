import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRiskGate } from "./gate";
import { startCodeHashGuard } from "./guard";

const ADAPTER = "0xadapter";
const GOOD = "0xgood";

describe("startCodeHashGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const guard = (gate: ReturnType<typeof createRiskGate>, getCodeHash: () => Promise<string>) => {
    const onProbeError = vi.fn();
    return {
      onProbeError,
      start: () =>
        startCodeHashGuard({ risk: gate, reader: { getCodeHash }, intervalMs: 1000, onProbeError }),
    };
  };

  it("verifies at boot, before any trading", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: "0xexpected" } });
    const { start } = guard(gate, async () => "0xtampered");
    await start();
    expect(gate.state()).toBe("HALTED"); // halted before the poll loop ever runs
  });

  // The reason this is periodic and not boot-only: a long-running bot must notice an upgrade.
  it("halts when the code changes after boot", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: GOOD } });
    let current = GOOD;
    const { start } = guard(gate, async () => current);
    const stop = await start();
    expect(gate.state()).toBe("RUNNING");

    current = "0xupgraded";
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  // Fail closed at boot: nothing has ever been verified, so an unverifiable target must not
  // receive the first tx.
  it("halts when the BOOT probe fails", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: GOOD } });
    const { start, onProbeError } = guard(gate, async () => {
      throw new Error("rpc down");
    });
    const stop = await start();
    expect(gate.state()).toBe("HALTED");
    expect(onProbeError).toHaveBeenCalledTimes(1);
    stop();
  });

  // Fail open afterwards: the target verified once, and an RPC blip is not evidence of
  // compromise. Halting on every hiccup would turn the guard into an availability bug.
  it("keeps running when a LATER probe fails, and retries", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: GOOD } });
    let healthy = true;
    const { start, onProbeError } = guard(gate, async () => {
      if (!healthy) throw new Error("rpc down");
      return GOOD;
    });
    const stop = await start();
    expect(gate.state()).toBe("RUNNING");

    healthy = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.state()).toBe("RUNNING");
    expect(onProbeError).toHaveBeenCalledTimes(1);

    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.state()).toBe("RUNNING");
    stop();
  });

  // A probe failure must not mask a real mismatch: once RPC recovers, the guard still halts.
  it("halts on a mismatch discovered after a transient probe failure", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: GOOD } });
    let mode: "ok" | "down" | "tampered" = "ok";
    const { start } = guard(gate, async () => {
      if (mode === "down") throw new Error("rpc down");
      return mode === "ok" ? GOOD : "0xtampered";
    });
    const stop = await start();

    mode = "down";
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.state()).toBe("RUNNING");

    mode = "tampered";
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  it("stops re-checking after stop()", async () => {
    const gate = createRiskGate({ expectedCodeHashes: { [ADAPTER]: GOOD } });
    const getCodeHash = vi.fn(async () => GOOD);
    const stop = await startCodeHashGuard({
      risk: gate,
      reader: { getCodeHash },
      intervalMs: 1000,
      onProbeError: () => {},
    });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getCodeHash).toHaveBeenCalledTimes(1); // boot only
  });
});
