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

  it("builds a permissive gate and starts no server when nothing is configured", async () => {
    const { gate, stop } = await start();
    expect(gate.state()).toBe("RUNNING");
    stop(); // no kill-switch server was bound; stop() must still be safe
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
