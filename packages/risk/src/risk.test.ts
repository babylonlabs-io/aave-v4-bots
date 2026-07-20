import { describe, expect, it } from "vitest";
import { createRiskGate } from "./index";

const action = (over = {}) => ({ kind: "liquidation", subject: "0xpos", ...over });

describe("@repo/risk createRiskGate", () => {
  it("is permissive with an empty config (never blocks, never halts)", () => {
    const gate = createRiskGate();
    expect(gate.state()).toBe("RUNNING");
    expect(gate.check(action({ expectedProfit: 0n, dataTimestampMs: 0 }))).toEqual({ allow: true });
    for (let i = 0; i < 100; i++) gate.recordOutcome({ ok: false });
    expect(gate.state()).toBe("RUNNING"); // no breaker threshold ⇒ never auto-halts
  });

  describe("kill-switch", () => {
    it("blocks every action while HALTED, and resume() clears it", () => {
      const gate = createRiskGate();
      gate.halt("manual");
      expect(gate.state()).toBe("HALTED");
      const decision = gate.check(action());
      expect(decision.allow).toBe(false);
      if (!decision.allow) expect(decision.reason).toContain("manual");

      gate.resume();
      expect(gate.state()).toBe("RUNNING");
      expect(gate.check(action())).toEqual({ allow: true });
    });
  });

  describe("circuit breaker", () => {
    it("auto-halts after N consecutive failures", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 3 });
      gate.recordOutcome({ ok: false });
      gate.recordOutcome({ ok: false });
      expect(gate.state()).toBe("RUNNING");
      gate.recordOutcome({ ok: false }); // 3rd
      expect(gate.state()).toBe("HALTED");
      expect(gate.check(action()).allow).toBe(false);
    });

    it("a success resets the consecutive counter", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 3 });
      gate.recordOutcome({ ok: false });
      gate.recordOutcome({ ok: false });
      gate.recordOutcome({ ok: true }); // reset
      gate.recordOutcome({ ok: false });
      gate.recordOutcome({ ok: false });
      expect(gate.state()).toBe("RUNNING"); // only 2 in a row since the reset
    });
  });

  describe("profit floor", () => {
    it("blocks an action below the floor, allows at/above", () => {
      const gate = createRiskGate({ minProfit: 1000n });
      expect(gate.check(action({ expectedProfit: 999n })).allow).toBe(false);
      expect(gate.check(action({ expectedProfit: 1000n })).allow).toBe(true);
      expect(gate.check(action({ expectedProfit: 5000n })).allow).toBe(true);
    });

    it("ignores the floor when the action omits expectedProfit", () => {
      const gate = createRiskGate({ minProfit: 1000n });
      expect(gate.check(action()).allow).toBe(true);
    });
  });

  describe("freshness", () => {
    it("blocks stale source data past the bound", () => {
      let t = 10_000;
      const gate = createRiskGate({ maxDataStalenessMs: 5_000, now: () => t });
      expect(gate.check(action({ dataTimestampMs: 6_000 })).allow).toBe(true); // 4s old
      expect(gate.check(action({ dataTimestampMs: 4_000 })).allow).toBe(false); // 6s old
      t = 20_000;
      expect(gate.check(action({ dataTimestampMs: 6_000 })).allow).toBe(false); // now 14s old
    });
  });
});
