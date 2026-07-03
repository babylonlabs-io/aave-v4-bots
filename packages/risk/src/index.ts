// The step-6 risk gate: the engine reports each intended action through it and is
// told allow/block, and feeds back outcomes so breakers can trip. Injected into the
// engines as a port (like metrics/logger). A zero-dependency, pure in-memory core;
// I/O-bound guards (code-hash via a chain read, shared HALTED across instances) are
// deferred to later adapters.

export type RiskState = "RUNNING" | "HALTED";

/** One action the engine is about to take, described for the gate to judge. */
export interface RiskAction {
  /** What is being attempted, for logs/metrics — e.g. "liquidation", "vault-acquisition". */
  kind: string;
  /** The subject id (position / vault), for logs. */
  subject: string;
  /** Expected profit in the profit unit (e.g. WBTC sats) — checked against `minProfit`. */
  expectedProfit?: bigint;
  /** When the source data was produced (ms epoch) — checked against `maxDataStalenessMs`. */
  dataTimestampMs?: number;
}

/** The result of an action, fed back so breakers can react. */
export interface ActionOutcome {
  ok: boolean;
}

export type RiskDecision = { allow: true } | { allow: false; reason: string };

export interface RiskGate {
  /** Current safety state; `HALTED` blocks every action until `resume()`. */
  state(): RiskState;
  /** Kill-switch — trip to `HALTED` with a reason. */
  halt(reason: string): void;
  /** Clear `HALTED` and reset the breaker counters. */
  resume(): void;
  /** Judge one action just before it is submitted. */
  check(action: RiskAction): RiskDecision;
  /** Record an action's result — feeds the consecutive-failure breaker. */
  recordOutcome(outcome: ActionOutcome): void;
}

export interface RiskConfig {
  /** Auto-`HALTED` after this many consecutive failed outcomes. Unset/0 disables. */
  maxConsecutiveFailures?: number;
  /** Block an action whose `expectedProfit` is below this floor. Unset disables. */
  minProfit?: bigint;
  /** Block an action whose data is older than this many ms. Unset disables. */
  maxDataStalenessMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Create an in-memory risk gate. With an empty config it is **permissive** — it
 * never blocks and never auto-halts — reproducing today's ungated behavior; each
 * threshold enables one guard.
 */
export function createRiskGate(config: RiskConfig = {}): RiskGate {
  const now = config.now ?? (() => Date.now());
  let state: RiskState = "RUNNING";
  let haltReason = "";
  let consecutiveFailures = 0;

  return {
    state: () => state,

    halt(reason) {
      state = "HALTED";
      haltReason = reason;
    },

    resume() {
      state = "RUNNING";
      haltReason = "";
      consecutiveFailures = 0;
    },

    check(action) {
      if (state === "HALTED") {
        return { allow: false, reason: `halted (${haltReason})` };
      }
      if (
        config.minProfit !== undefined &&
        action.expectedProfit !== undefined &&
        action.expectedProfit < config.minProfit
      ) {
        return { allow: false, reason: `below profit floor for ${action.subject}` };
      }
      if (
        config.maxDataStalenessMs !== undefined &&
        action.dataTimestampMs !== undefined &&
        now() - action.dataTimestampMs > config.maxDataStalenessMs
      ) {
        return { allow: false, reason: `stale source data for ${action.subject}` };
      }
      return { allow: true };
    },

    recordOutcome(outcome) {
      if (outcome.ok) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures++;
      if (config.maxConsecutiveFailures && consecutiveFailures >= config.maxConsecutiveFailures) {
        state = "HALTED";
        haltReason = `${consecutiveFailures} consecutive failures`;
      }
    },
  };
}
