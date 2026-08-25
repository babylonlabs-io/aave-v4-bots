import { describe, expect, it } from "vitest";
import { MAX_SOURCE_CLOCK_SKEW_MS, createRiskGate } from "./gate";
import type { ActionOutcome, RiskAction, RiskEvent, RiskGate } from "./types";

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

  describe("onEvent (operator alerting)", () => {
    it("fires once when a tripped breaker halts, and again on resume", () => {
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ maxConsecutiveFailures: 1, onEvent: (e) => events.push(e) });

      act(gate, { ok: false }); // trips → halted
      expect(events).toEqual([{ kind: "halted", reason: "1 consecutive failures" }]);

      gate.resume();
      expect(events).toEqual([
        { kind: "halted", reason: "1 consecutive failures" },
        { kind: "resumed" },
      ]);
    });

    it("fires on an explicit kill-switch halt", () => {
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ onEvent: (e) => events.push(e) });
      gate.halt("manual kill-switch");
      expect(events).toEqual([{ kind: "halted", reason: "manual kill-switch" }]);
    });

    it("emits on the transition only — a re-halt while already HALTED is silent", () => {
      // The code-hash guard re-halts every tick while a mismatch persists; the operator must not
      // get that alert once a minute forever.
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ onEvent: (e) => events.push(e) });
      gate.halt("first");
      gate.halt("second"); // already HALTED
      gate.halt("third");
      expect(events).toEqual([{ kind: "halted", reason: "first" }]);
    });

    it("does not fire on a resume that changes nothing", () => {
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ onEvent: (e) => events.push(e) });
      gate.resume(); // already RUNNING
      expect(events).toEqual([]);
    });

    it("swallows a throwing sink — alerting must never break the gate", () => {
      const gate = createRiskGate({
        onEvent: () => {
          throw new Error("sink is broken");
        },
      });
      // The halt must still take effect even though the sink threw.
      expect(() => gate.halt("x")).not.toThrow();
      expect(gate.state()).toBe("HALTED");
    });

    it("does not fire when startHalted (no RUNNING→HALTED transition happened)", () => {
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ startHalted: true, onEvent: (e) => events.push(e) });
      // Booting halted is a cold start, not a state change an operator needs re-told about.
      expect(events).toEqual([]);
      expect(gate.state()).toBe("HALTED");
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

    // The stamp arrives from an indexer response that is cast, never parsed, so the gate cannot
    // assume its own type holds. Every value below reaches `now() - stamp` as NaN or a negative,
    // and a guard written as "is the age too large" answers `false` to both — admitting exactly
    // the data it exists to refuse. These are the shapes a wire value actually arrives in.
    describe("a source timestamp that is not an instant", () => {
      const gate = () => createRiskGate({ maxDataStalenessMs: 5_000, now: () => 1_000_000 });
      const judge = (stamp: unknown) =>
        gate().openSlot(action({ dataTimestampMs: stamp as number }));

      it.each([
        ["a non-numeric string", "not-a-number"],
        ["an object", { x: 1 }],
        ["an array", [1]],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
        ["null", null],
        ["a fraction", 1_000_000.5],
        ["a magnitude past 2**53, where ms arithmetic stops being exact", 2 ** 53 + 2],
      ])("blocks %s", (_label, stamp) => {
        const slot = judge(stamp);
        expect(slot.allowed).toBe(false);
        expect(slot.reason).toMatch(/unusable source timestamp/);
      });

      // A numeric string still measures the right instant, so it is not a safety problem — but it
      // is not the declared type either, and the gate refuses rather than coercing. Parsing the
      // wire shape is the boundary's job; the gate only guarantees it cannot be fooled.
      it("blocks a numeric string rather than coercing it", () => {
        expect(judge("999000").allowed).toBe(false);
      });
    });

    // A source running ahead of us is the silent one: every age goes negative, so a bound written
    // only as "too old" admits data of any age at all. The stamp is a *chain block* timestamp, so
    // a small lead is normal and stays allowed — this blocks only a disagreement large enough that
    // no age computed from it means anything.
    describe("a source timestamp in the future", () => {
      const at = (stamp: number) =>
        createRiskGate({ maxDataStalenessMs: 5_000, now: () => 1_000_000 }).openSlot(
          action({ dataTimestampMs: stamp })
        );

      it("allows a lead within the clock-skew allowance", () => {
        expect(at(1_000_000 + MAX_SOURCE_CLOCK_SKEW_MS).allowed).toBe(true);
      });

      it("blocks a lead past it", () => {
        const slot = at(1_000_000 + MAX_SOURCE_CLOCK_SKEW_MS + 1);
        expect(slot.allowed).toBe(false);
        expect(slot.reason).toMatch(/in the future/);
      });

      // The case from the report: a stamp far enough ahead that the staleness comparison can never
      // fire again, whatever the real age of the data behind it.
      it("blocks a far-future stamp that would otherwise disable the guard for good", () => {
        expect(at(4_600_000).allowed).toBe(false);
      });

      // And the allowance is its own quantity, not the operator's bound: a tight freshness setting
      // must not start rejecting a healthy chain whose blocks run a few seconds ahead.
      it("does not tighten the future allowance when the staleness bound is tight", () => {
        const gate = createRiskGate({ maxDataStalenessMs: 2_000, now: () => 1_000_000 });
        expect(gate.openSlot(action({ dataTimestampMs: 1_003_000 })).allowed).toBe(true);
      });
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

    // A contended action (a broadcast tx that reverted because a competitor took the subject) is a
    // lost race, not our malfunction — it must free the slot without feeding the breaker.
    it("contended outcomes free the slot without feeding the breaker", () => {
      const gate = createRiskGate({ maxInFlight: 1, maxConsecutiveFailures: 2 });

      for (let i = 0; i < 5; i++) act(gate, { ok: false, contended: true });

      expect(gate.inFlight()).toBe(0);
      expect(gate.state()).toBe("RUNNING"); // breaker untouched
    });

    // Losing a race between two genuine failures must not reset the failure streak — otherwise a
    // steady drip of lost races would mask a bot that is actually malfunctioning.
    it("contended does not reset the consecutive-failure streak", () => {
      const gate = createRiskGate({ maxConsecutiveFailures: 2 });

      act(gate, { ok: false }); // failure 1
      act(gate, { ok: false, contended: true }); // lost race — neutral, streak stays at 1
      expect(gate.state()).toBe("RUNNING");
      act(gate, { ok: false }); // failure 2 → trips
      expect(gate.state()).toBe("HALTED");
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

  describe("token inventory", () => {
    const WBTC = "0xWBTC";
    const SIGNER = "0xsigner";
    /** The account every case below spends from — direct funding, where payer and signer are one. */
    const acct = (token = WBTC) => ({ owner: SIGNER, token });
    const spending = (amount: bigint, token = WBTC) => ({
      kind: "vault-acquisition",
      subject: "0xvault",
      spend: [{ owner: SIGNER, token, amount }],
    });

    const TX = "0xdeadbeef";

    // The regression this whole mechanism exists for. A tx that was broadcast and never resolved is
    // still owed by this balance, and a read taken while it sits un-mined reports the money as
    // though it were there. Clearing the count on that read hands the same balance out twice — and
    // in the arbitrageur the second spender is the *other* engine, against the same signer.
    describe("an outflow whose transaction has not settled", () => {
      const held = () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        gate.openSlot(spending(60n)).settle({ ok: false, unresolved: true, txHash: TX });
        return gate;
      };

      it("survives a refresh whose read cannot yet reflect it", () => {
        const gate = held();
        // The read still says 100 precisely because the tx has not mined.
        gate.setAvailable(acct(), 100n, 11n);

        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
        expect(gate.openSlot(spending(40n)).allowed).toBe(true);
        expect(gate.outflows()).toEqual([{ txHash: TX }]);
      });

      it("is released only on evidence, and then the balance stands on its own", () => {
        const gate = held();
        // The tx mined: the read is taken at a height that includes it, and the hold retired in the
        // same step — capacity must never sit between the two, holding neither.
        gate.retireOutflow(TX);
        gate.setAvailable(acct(), 40n, 12n);

        expect(gate.openSlot(spending(40n)).allowed).toBe(true);
        expect(gate.outflows()).toEqual([]);
      });

      // The failure the naive fix (subtract the balance delta) gets wrong: an inflow arriving while
      // the spend is still pending makes the balance look unchanged, or higher.
      it("is not masked by an inflow that arrives before it lands", () => {
        const gate = held();
        gate.setAvailable(acct(), 150n, 11n); // +50 in, the 60 still un-mined

        expect(gate.openSlot(spending(90n)).allowed).toBe(true);
        expect(gate.openSlot(spending(91n)).allowed).toBe(false);
      });

      // A receipt proves the tx mined; it does not prove the next read comes from a node that has
      // that block. So a confirmed spend is held too, on the same evidence rule.
      it("holds a confirmed spend until a read that covers its block", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        gate.openSlot(spending(60n)).settle({ ok: true, txHash: TX, minedAtBlock: 11n });

        expect(gate.outflows()).toEqual([{ txHash: TX, minedAtBlock: 11n }]);
        gate.setAvailable(acct(), 100n, 10n); // a lagging endpoint, still pre-spend
        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
      });

      it("holds every token one transaction owes", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        gate.setAvailable(acct("0xUSDC"), 100n, 10n);
        gate
          .openSlot({
            kind: "liquidation",
            subject: "0xpos",
            spend: [
              { owner: SIGNER, token: WBTC, amount: 60n },
              { owner: SIGNER, token: "0xUSDC", amount: 70n },
            ],
          })
          .settle({ ok: false, unresolved: true, txHash: TX });

        gate.setAvailable(acct(), 100n, 11n);
        gate.setAvailable(acct("0xUSDC"), 100n, 11n);
        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
        expect(gate.openSlot(spending(70n, "0xUSDC")).allowed).toBe(false);

        // One hash, one retirement, both tokens freed.
        gate.retireOutflow(TX);
        expect(gate.openSlot(spending(100n)).allowed).toBe(true);
      });

      // `settle` is idempotent by design (the precise path plus a `finally` backstop), and the
      // arbitrage engine settles the same slot from more than one place.
      it("counts one transaction once, however often its slot is settled", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        const slot = gate.openSlot(spending(60n));
        slot.settle({ ok: false, unresolved: true, txHash: TX });
        slot.settle({ ok: false, unresolved: true, txHash: TX });

        gate.setAvailable(acct(), 100n, 11n);
        expect(gate.openSlot(spending(40n)).allowed).toBe(true);
      });

      // Router funding keeps its own account of a signed authorization, which outlives the
      // transaction: a relay can still execute it after ours resolves. Two ledgers, one amount.
      it("does not hold a spend the funding mode accounts for itself", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        gate
          .openSlot({
            kind: "vault-acquisition",
            subject: "0xvault",
            spend: [{ owner: SIGNER, token: WBTC, amount: 60n, accounting: "caller" as const }],
          })
          .settle({ ok: false, unresolved: true, txHash: TX });

        expect(gate.outflows()).toEqual([]);
        // The published figure is already net of it, so the gate must not subtract it again.
        gate.setAvailable(acct(), 40n, 11n);
        expect(gate.openSlot(spending(40n)).allowed).toBe(true);
      });

      // Without a transaction there is nothing evidence could ever be about, so this one keeps the
      // old behaviour: counted until the next read, which is authoritative.
      it("falls back to clearing on refresh when there is no transaction to hold by", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 10n);
        gate.openSlot(spending(60n)).settle({ ok: false, unresolved: true });

        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
        gate.setAvailable(acct(), 100n, 11n);
        expect(gate.openSlot(spending(100n)).allowed).toBe(true);
      });
    });

    // Both engines publish the same signer balance, and this is last-writer-wins.
    describe("snapshot ordering", () => {
      it("ignores a read older than one already accepted", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 40n, 11n);
        gate.setAvailable(acct(), 100n, 10n); // started earlier, landed later

        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
        expect(gate.openSlot(spending(40n)).allowed).toBe(true);
      });

      it("accepts a read at the same height, which is the same state", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 100n, 11n);
        gate.setAvailable(acct(), 40n, 11n);

        expect(gate.openSlot(spending(60n)).allowed).toBe(false);
      });

      it("still accepts reads that carry no height — the ordering guard is opt-in", () => {
        const gate = createRiskGate();
        gate.setAvailable(acct(), 40n, 11n);
        gate.setAvailable(acct(), 100n);

        expect(gate.openSlot(spending(100n)).allowed).toBe(true);
      });
    });

    it("blocks an action the signer cannot afford, and frees the reservation on settle", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      const first = gate.openSlot(spending(60n));
      expect(first.allowed).toBe(true);
      expect(gate.reserved(acct())).toBe(60n);

      // 60 reserved leaves 40 spendable, so this does not fit.
      const blocked = gate.openSlot(spending(60n));
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("insufficient");

      // A revert transfers nothing, so the full balance is spendable again.
      first.settle({ ok: false });
      expect(gate.reserved(acct())).toBe(0n);
      expect(gate.openSlot(spending(100n)).allowed).toBe(true);
    });

    it("stops two concurrent engines from spending the same balance twice", () => {
      // The whole point of reserving inside `openSlot`: both engines see the same balance, and
      // without the reservation both would pass and collectively overdraw the shared signer.
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      const arbitrage = gate.openSlot(spending(80n));
      const liquidation = gate.openSlot({ ...spending(80n), kind: "liquidation" });

      expect(arbitrage.allowed).toBe(true);
      expect(liquidation.allowed).toBe(false);
    });

    it("keeps a confirmed spend counted until the balance is refreshed", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      const slot = gate.openSlot(spending(60n));
      slot.settle({ ok: true }); // the tokens really left

      // Releasing the reservation must not hand the same 60 back out: the chain balance is now 40,
      // but `available` still says 100 until someone reads it again.
      expect(gate.openSlot(spending(60n)).allowed).toBe(false);
      expect(gate.openSlot(spending(40n)).allowed).toBe(true);

      // A fresh read is authoritative and clears what we had been tracking separately.
      gate.setAvailable(acct(), 40n);
      expect(gate.reserved(acct())).toBe(40n); // the 40n slot above is still in flight
    });

    it("counts an unresolved broadcast as spent (the tx may still land)", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      const slot = gate.openSlot(spending(60n));
      slot.settle({ ok: false, unresolved: true });

      // Under-reporting here only skips work we could afford; assuming it never lands would
      // overdraw the signer if it does.
      expect(gate.openSlot(spending(60n)).allowed).toBe(false);
    });

    // A revert normally transfers nothing, so the reservation is released outright. That inference
    // breaks when the payment can be made by a transaction other than ours — an authorization for a
    // permissionless relay — and releasing it would hand the same balance out twice in one cycle.
    it("keeps a failed action's spend counted when its funds left anyway", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      gate.openSlot(spending(60n)).settle({ ok: false, contended: true, spent: true });

      expect(gate.reserved(acct())).toBe(0n);
      expect(gate.openSlot(spending(60n)).allowed).toBe(false);
      expect(gate.openSlot(spending(40n)).allowed).toBe(true);
    });

    it("releases a contended action's spend when its funds did not leave", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      gate.openSlot(spending(60n)).settle({ ok: false, contended: true });

      expect(gate.openSlot(spending(100n)).allowed).toBe(true);
    });

    it("releases the reservation when nothing was broadcast", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      gate.openSlot(spending(60n)).settle({ ok: false, abandoned: true });

      expect(gate.reserved(acct())).toBe(0n);
      expect(gate.openSlot(spending(100n)).allowed).toBe(true);
    });

    it("fails closed on a token it has never been given a balance for", () => {
      const gate = createRiskGate();

      const blocked = gate.openSlot(spending(1n, "0xUNKNOWN"));

      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("no known balance");
    });

    it("reserves nothing when any token in a multi-token spend does not fit", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);
      gate.setAvailable(acct("0xUSDC"), 10n);

      const blocked = gate.openSlot({
        kind: "liquidation",
        subject: "0xborrower",
        spend: [
          { owner: SIGNER, token: WBTC, amount: 50n },
          { owner: SIGNER, token: "0xUSDC", amount: 50n }, // does not fit
        ],
      });

      expect(blocked.allowed).toBe(false);
      // All-or-nothing: the WBTC leg must not have been reserved on the way to failing.
      expect(gate.reserved(acct())).toBe(0n);
    });

    // Two engines in one process do not necessarily spend the same balance sheet: a router-funded
    // engine draws on a treasury while another still draws on the signer. Before the ledger carried
    // the owner, both wrote one entry — last writer won, and reservations netted across accounts.
    it("keeps two owners of the same token on separate balances", () => {
      const TREASURY = "0xtreasury";
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);
      gate.setAvailable({ owner: TREASURY, token: WBTC }, 10n);

      // Reserving the signer's whole balance must not touch what the treasury can spend...
      const signerSlot = gate.openSlot(spending(100n));
      expect(signerSlot.allowed).toBe(true);
      expect(
        gate.openSlot({
          kind: "vault-acquisition",
          subject: "0xvault2",
          spend: [{ owner: TREASURY, token: WBTC, amount: 10n }],
        }).allowed
      ).toBe(true);

      // ...and the treasury's smaller balance still binds its own spending.
      expect(
        gate.openSlot({
          kind: "vault-acquisition",
          subject: "0xvault3",
          spend: [{ owner: TREASURY, token: WBTC, amount: 1n }],
        }).allowed
      ).toBe(false);
      expect(gate.reserved({ owner: TREASURY, token: WBTC })).toBe(10n);
      expect(gate.reserved(acct())).toBe(100n);
    });

    it("fails closed on an owner it has never been given a balance for", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct(), 100n);

      // The token is known — for a different account. Capacity for this one is still unknown.
      const blocked = gate.openSlot({
        kind: "vault-acquisition",
        subject: "0xvault",
        spend: [{ owner: "0xtreasury", token: WBTC, amount: 1n }],
      });

      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("no known balance");
    });

    it("treats the same owner spelled differently as one balance", () => {
      const gate = createRiskGate();
      gate.setAvailable({ owner: "0xAbCd", token: WBTC }, 100n);

      const spend = (owner: string, amount: bigint) => ({
        kind: "vault-acquisition",
        subject: "0xvault",
        spend: [{ owner, token: WBTC, amount }],
      });
      expect(gate.openSlot(spend("0xabcd", 80n)).allowed).toBe(true);
      expect(gate.openSlot(spend("0xABCD", 80n)).allowed).toBe(false);
    });

    it("treats the same token spelled differently as one balance", () => {
      const gate = createRiskGate();
      gate.setAvailable(acct("0xAbCd"), 100n);

      expect(gate.openSlot(spending(80n, "0xabcd")).allowed).toBe(true);
      expect(gate.openSlot(spending(80n, "0xABCD")).allowed).toBe(false);
    });

    it("ignores inventory for actions that declare no spend", () => {
      const gate = createRiskGate();

      expect(gate.openSlot({ kind: "liquidation", subject: "0xb" }).allowed).toBe(true);
    });
  });

  describe("code-hash guard", () => {
    const reader = (hashes: Record<string, string | undefined>) => async (address: string) =>
      hashes[address];

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

    // An RPC blip is not evidence of compromise: reject so the caller retries, do NOT halt — but
    // only once there is an earlier success to fall back on. These two are the same call against
    // the same failure, and the only difference is whether this gate has ever read the target.
    it("rejects without halting when the probe fails after a successful verification", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xabc" } });
      await gate.verifyCode(reader({ "0xadapter": "0xabc" }));
      expect(gate.everVerified()).toBe(true);

      const failing = async () => {
        throw new Error("rpc down");
      };
      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      expect(gate.state()).toBe("RUNNING");
    });

    it("halts when the probe fails and nothing has ever been verified", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xabc" } });
      const failing = async () => {
        throw new Error("rpc down");
      };
      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      expect(gate.state()).toBe("HALTED");
      expect(gate.everVerified()).toBe(false);
    });

    // Regression: a detected compromise must not hide behind an unrelated RPC blip. Batching the
    // reads (`Promise.all`) would reject before `0xa`'s mismatch was ever compared — and periodic
    // checks do not halt on a probe failure, so the bot would keep trading against changed code.
    it("halts on a mismatch even when a DIFFERENT address is unreadable", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xa": "0xgood", "0xb": "0xgood" } });
      const read = async (address: string) => {
        if (address === "0xb") throw new Error("rpc down");
        return "0xtampered";
      };

      await expect(gate.verifyCode(read)).resolves.toBeUndefined(); // mismatch wins, no throw
      expect(gate.state()).toBe("HALTED");
    });

    it("halts on missing code even when a different address is unreadable", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xa": "0xgood", "0xb": "0xgood" } });
      const read = async (address: string) => {
        if (address === "0xb") throw new Error("rpc down");
        return undefined;
      };

      await gate.verifyCode(read);
      expect(gate.state()).toBe("HALTED");
    });

    // The converse: nothing is wrong with what we could read, so the probe error surfaces. It also
    // halts here, because one unreadable address means this gate still has not verified everything
    // it pinned — a partial pass is not a pass.
    it("raises the probe error when every address it could read is intact", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xa": "0xgood", "0xb": "0xgood" } });
      const read = async (address: string) => {
        if (address === "0xb") throw new Error("rpc down");
        return "0xgood";
      };

      await expect(gate.verifyCode(read)).rejects.toThrow("rpc down");
      expect(gate.everVerified()).toBe(false);
    });
  });

  describe("startHalted", () => {
    it("starts in HALTED and blocks until resumed", () => {
      const gate = createRiskGate({ startHalted: true });
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
      expect(gate.resume()).toBe(true);
      expect(gate.openSlot(action()).allowed).toBe(true);
    });
  });

  // A halt that lands on an already-HALTED gate raises no event, so under `startHalted` a code-hash
  // failure is invisible: no alert, and this package has no logger to print one. An operator sees a
  // bot they halted themselves and clears it. What stops that is the *cause* outliving the reason
  // string — resume refuses regardless of whether anyone was ever told.
  describe("resume cannot clear a code-hash halt", () => {
    const pinned = { startHalted: true, expectedCodeHashes: { "0xadapter": "0xgood" } };

    it("refuses after a mismatch recorded silently under startHalted", async () => {
      const events: RiskEvent[] = [];
      const gate = createRiskGate({ ...pinned, onEvent: (e) => events.push(e) });

      await gate.verifyCode(async () => "0xtampered");
      expect(events).toEqual([]); // silent, because the gate was already HALTED

      expect(gate.resume()).toBe(false);
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
      expect(gate.haltReason()).toMatch(/code hash mismatch/);
    });

    // Passes are not serialised: `startCodeHashGuard` ticks on an interval, so a probe slower than
    // that interval overlaps its successor. A clean answer is evidence about the chain the pass
    // read, not about the chain now — so the pass that finishes last must not be the one that wins.
    it("refuses when a stale clean pass lands after a newer mismatch", async () => {
      const gate = createRiskGate(pinned);
      let releaseStale: (hash: string) => void = () => {};
      const stalled = new Promise<string>((resolve) => {
        releaseStale = resolve;
      });

      // Pass A reads against a lagging backend and hangs mid-flight.
      const stale = gate.verifyCode(() => stalled);
      // Pass B sees the upgrade and halts.
      await gate.verifyCode(async () => "0xtampered");
      expect(gate.resume()).toBe(false);

      // A now returns the pre-upgrade hash. It answers a question about a chain that has moved.
      releaseStale("0xgood");
      await stale;

      expect(gate.resume()).toBe(false);
      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
    });

    // The other side of the same rule: once a pass that started *after* the mismatch reads clean,
    // the halt is about a state that no longer holds and the operator may act on that.
    it("lets a pass started after the mismatch retire it", async () => {
      const gate = createRiskGate(pinned);
      await gate.verifyCode(async () => "0xtampered");
      expect(gate.resume()).toBe(false);

      await gate.verifyCode(async () => "0xgood");

      expect(gate.resume()).toBe(true);
      expect(gate.state()).toBe("RUNNING");
    });

    // Same cause, different evidence: a self-destructed target or a wrong address reads as no code
    // at all, which is the compromise this guard exists to catch and not an operator's own halt.
    it("refuses after the target turns out to have no code", async () => {
      const gate = createRiskGate(pinned);
      await gate.verifyCode(async () => undefined);

      expect(gate.resume()).toBe(false);
      expect(gate.haltReason()).toMatch(/no code at/);
    });

    it("refuses after a boot probe failure, and keeps refusing while it persists", async () => {
      const gate = createRiskGate(pinned);
      const failing = async () => {
        throw new Error("rpc down");
      };

      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      expect(gate.resume()).toBe(false);
      // The retry a tick later fails the same way and must not soften the verdict.
      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      expect(gate.resume()).toBe(false);
      expect(gate.state()).toBe("HALTED");
    });

    // The hole this closes: the periodic guard fails *open* on a probe failure, which is only
    // sound because the target was verified before. Resuming a never-verified gate falsified that,
    // and the bot then traded forever against bytecode it had never once read.
    it("does not fail open on later probe failures when nothing has ever verified", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xgood" } });
      const failing = async () => {
        throw new Error("rpc down");
      };

      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");
      gate.resume(); // refused, but assume an operator tried
      await expect(gate.verifyCode(failing)).rejects.toThrow("rpc down");

      expect(gate.state()).toBe("HALTED");
      expect(gate.openSlot(action()).allowed).toBe(false);
    });

    it("clears the cause on a clean pass, without resuming trading by itself", async () => {
      const gate = createRiskGate(pinned);
      await gate.verifyCode(async () => "0xtampered");
      expect(gate.resume()).toBe(false);

      await gate.verifyCode(async () => "0xgood");
      expect(gate.state()).toBe("HALTED"); // proving the target is sound is not a decision to trade
      expect(gate.everVerified()).toBe(true);

      expect(gate.resume()).toBe(true);
      expect(gate.openSlot(action()).allowed).toBe(true);
    });

    // The other direction: a manual halt is the operator's own, and stays theirs to reverse.
    it("still clears a manual halt on a gate whose code did verify", async () => {
      const gate = createRiskGate({ expectedCodeHashes: { "0xadapter": "0xgood" } });
      await gate.verifyCode(async () => "0xgood");
      gate.halt("incident");

      expect(gate.resume()).toBe(true);
      expect(gate.state()).toBe("RUNNING");
    });
  });
});
