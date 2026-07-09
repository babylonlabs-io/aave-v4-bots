import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRiskRuntime } from "./runtime";

const ADAPTER = "0xadapter";
const GOOD = "0xgood";

const silentLogger = { info: vi.fn(), warn: vi.fn() };

const start = (over: Partial<Parameters<typeof startRiskRuntime>[0]> = {}) =>
  startRiskRuntime({
    config: {},
    codeCheckIntervalMs: 1000,
    reader: { getCodeHash: async () => GOOD },
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

  it("builds a permissive gate with no routes when nothing is configured", async () => {
    const { gate, routes, routeNames, stop } = await start();
    expect(gate.state()).toBe("RUNNING");
    expect(routes).toEqual([]); // no RISK_CONTROL_TOKEN_REF ⇒ kill switch unmounted
    expect(routeNames).toEqual([]);
    stop();
  });

  it("mounts the kill-switch routes when a token ref resolves", async () => {
    const getSecret = vi.fn(async () => "s3cret");
    const { routes, routeNames, stop } = await start({
      controlTokenRef: "BOT_CONTROL_TOKEN",
      getSecret,
    });

    expect(getSecret).toHaveBeenCalledWith("BOT_CONTROL_TOKEN");
    expect(routes).toHaveLength(1);
    expect(routeNames.join(" ")).toContain("/halt");
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
      reader: { getCodeHash: async () => "0xtampered" },
    });
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  it("halts when the boot probe cannot reach the chain (fail closed)", async () => {
    const { gate, stop } = await start({
      config: { expectedCodeHashes: { [ADAPTER]: GOOD } },
      reader: {
        getCodeHash: async () => {
          throw new Error("rpc down");
        },
      },
    });
    expect(gate.state()).toBe("HALTED");
    stop();
  });

  it("stop() ends the periodic re-check", async () => {
    const getCodeHash = vi.fn(async () => GOOD);
    const { stop } = await start({
      config: { expectedCodeHashes: { [ADAPTER]: GOOD } },
      reader: { getCodeHash },
    });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getCodeHash).toHaveBeenCalledTimes(1); // boot only
  });
});
