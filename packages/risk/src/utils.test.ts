import { describe, expect, it } from "vitest";
import { createRiskGate } from "./gate";
import { settleUnfinished } from "./utils";

const action = { kind: "liquidation", subject: "0xpos" };

describe("settleUnfinished", () => {
  it("releases slots nobody settled", () => {
    const gate = createRiskGate({ maxInFlight: 2 });
    const slots = [gate.openSlot(action), gate.openSlot(action)];
    expect(gate.inFlight()).toBe(2);

    settleUnfinished(slots);
    expect(gate.inFlight()).toBe(0);
  });

  // The backstop must never overwrite a real outcome, or it would erase breaker signal.
  it("leaves an already-settled slot alone", () => {
    const gate = createRiskGate({ maxConsecutiveFailures: 1 });
    const slot = gate.openSlot(action);
    slot.settle({ ok: false }); // a genuine failure — trips the breaker
    expect(gate.state()).toBe("HALTED");

    settleUnfinished([slot]); // no-op: does not un-count the failure, does not double-release
    expect(gate.inFlight()).toBe(0);
    expect(gate.state()).toBe("HALTED");
  });

  // Abandoned, so a bookkeeping miss alone can never trip the breaker.
  it("does not feed the breaker", () => {
    const gate = createRiskGate({ maxConsecutiveFailures: 1 });
    settleUnfinished([gate.openSlot(action)]);
    expect(gate.state()).toBe("RUNNING");
  });
});
