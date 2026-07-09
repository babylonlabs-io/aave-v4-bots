import { describe, expect, it } from "vitest";
import { createRiskGate } from "./gate";
import type { ActionOutcome, RiskAction, RiskGate } from "./types";

const action = (over: Partial<RiskAction> = {}): RiskAction => ({
  kind: "liquidation",
  subject: "0xpos",
  ...over,
});

/** Open a slot and settle it — one complete action, the shape every engine path takes. */
const act = (gate: RiskGate, outcome: ActionOutcome, over: Partial<RiskAction> = {}) => {
  const slot = gate.openSlot(action(over));
  slot.settle(outcome);
  return slot;
};

describe("@repo/risk createRiskGate", () => {
  it("is permissive with an empty config (never blocks, never halts)", () => {
    const gate = createRiskGate();
    expect(gate.state()).toBe("RUNNING");
    expect(gate.openSlot(action({ expectedProfit: 0n, dataTimestampMs: 0 })).allowed).toBe(true);
    for (let i = 0; i < 100; i++) act(gate, { ok: false });
    expect(gate.state()).toBe("RUNNING"); // no breaker threshold ⇒ never auto-halts
  });

  describe("kill-switch", () => {
    it("blocks every action while HALTED, and resume() clears it", () => {
      const gate = createRiskGate();
      gate.halt("manual");
      expect(gate.state()).toBe("HALTED");
      const slot = gate.openSlot(action());
      expect(slot.allowed).toBe(false);
      expect(slot.reason).toContain("manual");

      gate.resume();
      expect(gate.state()).toBe("RUNNING");
      expect(gate.openSlot(action()).allowed).toBe(true);
    });
  });

  describe("circuit breaker", () => {
    it("auto-halts after N consecutive failures", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 3 });
      act(gate, { ok: false });
      act(gate, { ok: false });
      expect(gate.state()).toBe("RUNNING");
      act(gate, { ok: false }); // 3rd
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
    });

    it("a success resets the consecutive counter", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 3 });
      act(gate, { ok: false });
      act(gate, { ok: false });
      act(gate, { ok: true }); // reset
      act(gate, { ok: false });
      act(gate, { ok: false });
      expect(gate.state()).toBe("RUNNING"); // only 2 in a row since the reset
    });
  });

  describe("profit floor", () => {
    it("blocks an action below the floor, allows at/above", () => {
      const gate = createRiskGate({ minProfit: 1000n });
      expect(gate.openSlot(action({ expectedProfit: 999n })).allowed).toBe(false);
      expect(gate.openSlot(action({ expectedProfit: 1000n })).allowed).toBe(true);
      expect(gate.openSlot(action({ expectedProfit: 5000n })).allowed).toBe(true);
    });

    // Deliberately skip (not block) — liquidation profit isn't derivable off-chain yet, so
    // fail-closing here would disable every liquidation the moment a floor is set.
    it("ignores the floor when the action omits expectedProfit", () => {
      const gate = createRiskGate({ minProfit: 1000n });
      expect(gate.openSlot(action()).allowed).toBe(true);
    });
  });

  describe("freshness", () => {
    it("blocks stale source data past the bound", () => {
      let t = 10_000;
      const gate = createRiskGate({ maxDataStalenessMs: 5_000, now: () => t });
      expect(gate.openSlot(action({ dataTimestampMs: 6_000 })).allowed).toBe(true); // 4s old
      expect(gate.openSlot(action({ dataTimestampMs: 4_000 })).allowed).toBe(false); // 6s old
      t = 20_000;
      expect(gate.openSlot(action({ dataTimestampMs: 6_000 })).allowed).toBe(false); // now 14s
    });

    // Fail-closed: unlike the profit floor, a configured staleness bound that cannot be
    // evaluated blocks — trading on data of unknown age defeats the guard.
    it("blocks when configured but the action omits dataTimestampMs", () => {
      const gate = createRiskGate({ maxDataStalenessMs: 5_000, now: () => 10_000 });
      const slot = gate.openSlot(action());
      expect(slot.allowed).toBe(false);
      expect(slot.reason).toContain("missing source timestamp");
    });

    it("ignores a missing dataTimestampMs when the bound is not configured", () => {
      expect(createRiskGate().openSlot(action()).allowed).toBe(true);
    });
  });

  describe("exposure cap", () => {
    it("blocks once maxInFlight slots are open, and frees them on settle", () => {
      const gate = createRiskGate({ maxInFlight: 2 });

      const first = gate.openSlot(action());
      const second = gate.openSlot(action());
      expect(first.allowed && second.allowed).toBe(true);
      expect(gate.inFlight()).toBe(2);

      const blocked = gate.openSlot(action());
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("exposure cap");

      first.settle({ ok: true }); // frees one
      expect(gate.inFlight()).toBe(1);
      expect(gate.openSlot(action()).allowed).toBe(true);
      expect(gate.inFlight()).toBe(2);
    });

    it("does not reserve a slot for a blocked action", () => {
      const gate = createRiskGate({ maxInFlight: 1, minProfit: 100n });
      expect(gate.openSlot(action({ expectedProfit: 1n })).allowed).toBe(false); // below floor
      expect(gate.inFlight()).toBe(0);
      expect(gate.openSlot(action({ expectedProfit: 100n })).allowed).toBe(true);
    });

    // The whole point of returning a slot rather than a bare decision: settling twice (say, the
    // real exit path plus the `finally` backstop) must not release someone else's slot.
    it("settle() is idempotent — a double settle releases only one slot", () => {
      const gate = createRiskGate({ maxInFlight: 2 });
      const a = gate.openSlot(action());
      gate.openSlot(action()); // b, left open
      expect(gate.inFlight()).toBe(2);

      a.settle({ ok: true });
      a.settle({ ok: false }); // ignored — and must not touch b's slot or the breaker
      expect(gate.inFlight()).toBe(1);
    });

    it("settling a blocked slot is a no-op", () => {
      const gate = createRiskGate({ maxInFlight: 1, maxConsecutiveFailures: 1 });
      const open = gate.openSlot(action());
      const blocked = gate.openSlot(action());
      expect(blocked.allowed).toBe(false);

      blocked.settle({ ok: false }); // reserved nothing; must not free `open`'s slot or trip
      expect(gate.inFlight()).toBe(1);
      expect(gate.state()).toBe("RUNNING");
      open.settle({ ok: true });
      expect(gate.inFlight()).toBe(0);
    });

    // An abandoned action releases its slot but must NOT look like a chain failure.
    it("abandoned outcomes free the slot without feeding the breaker", () => {
      const gate = createRiskGate({ maxInFlight: 1, maxConsecutiveFailures: 2 });

      for (let i = 0; i < 5; i++) act(gate, { ok: false, abandoned: true });

      expect(gate.inFlight()).toBe(0);
      expect(gate.state()).toBe("RUNNING"); // breaker untouched
    });

    // Halting does not land the txs already in the mempool. If resume() zeroed the counter, an
    // operator could halt+resume mid-flight and let the gate authorize beyond the cap.
    it("resume() does NOT clear live exposure", () => {
      const gate = createRiskGate({ maxInFlight: 1 });
      const pending = gate.openSlot(action()); // one tx now pending on chain
      expect(pending.allowed).toBe(true);
      gate.halt("manual");
      gate.resume();

      expect(gate.inFlight()).toBe(1);
      expect(gate.openSlot(action()).allowed).toBe(false); // still capped by the pending tx

      pending.settle({ ok: true }); // its receipt lands
      expect(gate.openSlot(action()).allowed).toBe(true);
    });

    it("resume() still resets the consecutive-failure breaker", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 2 });
      act(gate, { ok: false });
      gate.resume();
      act(gate, { ok: false }); // would be the 2nd in a row without the reset
      expect(gate.state()).toBe("RUNNING");
    });
  });

  describe("code-hash guard", () => {
    const reader = (hashes: Record<string, string | undefined>) => ({
      getCodeHash: async (address: string) => hashes[address],
    });

    it("is a no-op when unconfigured", async () => {
      const gate = createRiskGate();
      await gate.verifyCode(reader({}));
      expect(gate.state()).toBe("RUNNING");
    });

    it("stays RUNNING when every hash matches (case-insensitive)", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xABC" } });
      await gate.verifyCode(reader({ "0xadapter": "0xabc" }));
      expect(gate.state()).toBe("RUNNING");
    });

    it("halts on a mismatched hash", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xabc" } });
      await gate.verifyCode(reader({ "0xadapter": "0xdead" }));
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
    });

    it("halts when the target has no code (self-destructed / wrong address)", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xabc" } });
      await gate.verifyCode(reader({ "0xadapter": undefined }));
      expect(gate.state()).toBe("HALTED");
    });

    // An RPC blip is not evidence of compromise: reject so the caller retries, do NOT halt.
    it("rejects without halting when the probe itself fails", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xabc" } });
      const failing = {
        getCodeHash: async () => {
          throw new Error("rpc down");
        },
      };
      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      expect(gate.state()).toBe("RUNNING");
    });
  });

  describe("startHalted", () => {
    it("starts in HALTED and blocks until resumed", () => {
      const gate = createRiskGate({ startHalted: true });
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
      gate.resume();
      expect(gate.openSlot(action()).allowed).toBe(true);
    });
  });
});
