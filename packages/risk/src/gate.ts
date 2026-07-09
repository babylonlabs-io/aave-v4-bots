import type { ActionOutcome, RiskAction, RiskConfig, RiskGate, RiskSlot, RiskState } from "./types";

/**
 * Create an in-memory risk gate. With an empty config it is **permissive** — it never blocks and
 * never auto-halts — reproducing the ungated behavior; each threshold enables one guard.
 */
export function createRiskGate(config: RiskConfig = {}): RiskGate {
  const now = config.now ?? (() => Date.now());
  let state: RiskState = config.startHalted ? "HALTED" : "RUNNING";
  let haltReason = config.startHalted ? "started halted (kill-switch)" : "";
  let consecutiveFailures = 0;
  let inFlight = 0;

  const halt = (reason: string) => {
    state = "HALTED";
    haltReason = reason;
  };

  /** A blocked slot reserved nothing, so it starts settled and `settle()` is a no-op. */
  const blockedSlot = (reason: string): RiskSlot => ({ allowed: false, reason, settle: () => {} });

  /** The guards, in order. Returns a block reason, or `undefined` to allow. Reserves nothing. */
  const evaluate = (action: RiskAction): string | undefined => {
    if (state === "HALTED") return `halted (${haltReason})`;

    // Exposure cap — bound how many actions may be in flight at once.
    if (config.maxInFlight !== undefined && inFlight >= config.maxInFlight) {
      return `exposure cap reached (${inFlight}/${config.maxInFlight} in flight)`;
    }

    // Profit floor. A missing `expectedProfit` **skips** the guard rather than blocking:
    // liquidation profit is not derivable off-chain today, so fail-closing here would silently
    // disable every liquidation the moment an operator sets a floor. The arbitrage engine
    // always supplies it. (Asymmetric with freshness below — deliberately.)
    if (
      config.minProfit !== undefined &&
      action.expectedProfit !== undefined &&
      action.expectedProfit < config.minProfit
    ) {
      return `below profit floor for ${action.subject}`;
    }

    // Freshness. Fail-closed: opting into a staleness bound and then being unable to evaluate
    // it would mean trading on data of unknown age. A current indexer always supplies the
    // timestamp, so its absence is an anomaly (stale deployment, or a failed block probe).
    if (config.maxDataStalenessMs !== undefined) {
      if (action.dataTimestampMs === undefined) {
        return `missing source timestamp for ${action.subject}`;
      }
      if (now() - action.dataTimestampMs > config.maxDataStalenessMs) {
        return `stale source data for ${action.subject}`;
      }
    }

    return undefined;
  };

  /** Release one reserved slot and feed the breaker. Called at most once per slot. */
  const release = (outcome: ActionOutcome) => {
    inFlight--;

    // Abandoned pre-broadcast: the slot is released, but this says nothing about the chain.
    if (outcome.abandoned) return;

    if (outcome.ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    if (config.maxConsecutiveFailures && consecutiveFailures >= config.maxConsecutiveFailures) {
      halt(`${consecutiveFailures} consecutive failures`);
    }
  };

  return {
    state: () => state,
    inFlight: () => inFlight,

    halt,

    resume() {
      state = "RUNNING";
      haltReason = "";
      consecutiveFailures = 0;
      // `inFlight` is deliberately NOT cleared. Halting does not land the txs already in the
      // mempool, so zeroing here would let an operator bypass the cap: halt + resume while a
      // liquidation awaits its receipt, and the arbitrage engine sharing this gate could send
      // beyond `maxInFlight`. The engines settle every reserved slot on every exit path — see
      // `RiskSlot` and its `finally` backstop — so the count drains on its own and cannot leak.
    },

    openSlot(action) {
      const blocked = evaluate(action);
      if (blocked) return blockedSlot(blocked);

      // Allowed — reserve the exposure slot. The returned slot is the only way to release it.
      inFlight++;
      let settled = false;
      return {
        allowed: true,
        reason: "",
        settle(outcome: ActionOutcome) {
          if (settled) return; // idempotent: the precise exit path wins over the `finally`
          settled = true;
          release(outcome);
        },
      };
    },

    async verifyCode(reader) {
      const expected = config.expectedCodeHashes;
      if (!expected) return;

      for (const [address, want] of Object.entries(expected)) {
        // A probe error propagates (RPC blip ⇒ retry next tick); it must not halt trading.
        const got = await reader.getCodeHash(address);

        if (got === undefined) {
          halt(`no code at ${address} (expected ${want})`);
          return;
        }
        if (got.toLowerCase() !== want.toLowerCase()) {
          halt(`code hash mismatch at ${address}: got ${got}, expected ${want}`);
          return;
        }
      }
    },
  };
}
