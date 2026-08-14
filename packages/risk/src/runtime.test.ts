import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRiskRuntime } from "./runtime";

const ADAPTER = "0xadapter";
const GOOD = "0xgood";

const silentLogger = { info: vi.fn(), warn: vi.fn() };

const start = (over: Partial<Parameters<typeof startRiskRuntime>[0]> = {}) =>
  startRiskRuntime({
    config: {},
    codeCheckIntervalMs: 1000,
    controlPort: 0, // ephemeral, only bound when a control token is configured
    controlHost: "127.0.0.1",
    read: async (_address: string) => GOOD,
    getSecret: async () => "token",
    logger: silentLogger,
    ...over,
  });

describe("startRiskRuntime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // The kill switch is opt-in, and asking for one is a statement about how this deployment expects
  // to be stopped. Booting without the endpoint it asked for would leave the operator believing
  // they can halt trading remotely when they cannot — so the boot fails instead.
  it("fails the boot when the kill switch it was told to mount cannot bind", async () => {
    await expect(
      start({ controlTokenRef: "env:TOKEN", controlHost: "203.0.113.7" })
    ).rejects.toThrow(/kill switch could not bind/);
  });

  // The counterpart: no token means no endpoint was asked for, which is a configuration the code
  // already announces rather than refuses. An unbindable host must not turn that into a failure.
  it("still boots with no token configured, whatever the control host says", async () => {
    const { gate, stop } = await start({ controlHost: "203.0.113.7" });
    expect(gate.state()).toBe("RUNNING");
    stop();
  });

  it("builds a permissive gate and starts no server when nothing is configured", async () => {
    const { gate, stop } = await start();
    expect(gate.state()).toBe("RUNNING");
    stop(); // no kill-switch server was bound; stop() must still be safe
  });

  // With no pinned hashes there is nothing to verify, so there must be no probe and no timer.
  it("never reads the chain, or arms a timer, when no hashes are pinned", async () => {
    const read = vi.fn(async (_address: string) => GOOD);
    const { stop } = await start({ read });

    expect(read).not.toHaveBeenCalled(); // no boot probe
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled(); // and no periodic re-check
    stop();
  });

  it("resolves the control token through the secrets provider when configured", async () => {
    const getSecret = vi.fn(async () => "s3cret");
    const { stop } = await start({ controlTokenRef: "BOT_CONTROL_TOKEN", getSecret });

    expect(getSecret).toHaveBeenCalledWith("BOT_CONTROL_TOKEN");
    stop();
  });

  it("honours startHalted", async () => {
    const { gate, stop } = await start({ config: { startHalted: true } });
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  // The ordering this helper exists to guarantee: the gate is already HALTED by the time the
  // caller gets it back, so no engine can be wired up and send a tx against tampered bytecode.
  it("verifies pinned bytecode BEFORE returning the gate", async () => {
    const { gate, stop } = await start({
      config: { expectedCodeHashes: { [ADAPTER]: GOOD } },
      read: async (_address: string) => "0xtampered",
    });
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  it("halts when the boot probe cannot reach the chain (fail closed)", async () => {
    const { gate, stop } = await start({
      config: { expectedCodeHashes: { [ADAPTER]: GOOD } },
      read: async (_address: string) => {
        throw new Error("rpc down");
      },
    });
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  it("stop() ends the periodic re-check", async () => {
    const read = vi.fn(async (_address: string) => GOOD);
    const { stop } = await start({
      config: { expectedCodeHashes: { [ADAPTER]: GOOD } },
      read,
    });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1); // boot only
  });
});
