// The risk gate: the engine reports each intended action through it and is told allow/block, and
// feeds back outcomes so breakers can trip. Injected into the engines as a port (like
// metrics/logger), and there must be exactly **one per process** so a kill-switch halts every
// engine that process drives.
//
// The per-candidate `openSlot()` stays pure and synchronous. The one I/O-bound guard (code-hash)
// lives in `verifyCode()`, which the composition root calls at boot and on an interval.

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

/** The result of an action, reported through the `RiskSlot` that authorized it. */
export interface ActionOutcome {
  ok: boolean;
  /**
   * The action was abandoned **before any tx was broadcast** (duplicate in-flight intent,
   * gas-estimation revert, …). Releases the in-flight slot but does **not** feed the
   * consecutive-failure breaker: it is not evidence the chain is rejecting us.
   */
  abandoned?: boolean;
}

/**
 * The gate's answer about one action, and — when it allowed the action — the in-flight slot it
 * reserved for it.
 *
 * Asking the gate is not a read-only question: an allowed answer *reserves exposure*, and that
 * exposure has to be released or the cap eventually wedges the bot shut. So the answer and the
 * means of releasing it are one object. `settle()` is idempotent, which lets a caller settle on
 * the precise exit path AND settle unconditionally in a `finally` (see `settleUnfinished`),
 * with only the first taking effect.
 *
 * A blocked slot reserved nothing and starts already settled; settling it is a no-op.
 */
export interface RiskSlot {
  readonly allowed: boolean;
  /** Why the gate blocked. Empty when `allowed`. */
  readonly reason: string;
  /** Report the outcome, releasing the slot. The first call wins; later calls are no-ops. */
  settle(outcome: ActionOutcome): void;
}

/**
 * Reads the deployed-bytecode hash of one address, or `undefined` when it has no code. Supplied
 * by the composition root over a chain client (`@repo/chain`'s `readCodeHash`).
 *
 * A function rather than an interface: `risk` needs exactly one read, so there is no port to own
 * — and therefore no type either package has to import from the other. A rejected promise means
 * the *probe* failed (RPC blip), which is distinct from "no code here".
 *
 * Deliberately **per-address**, not batched: `verifyCode` must be able to act on the addresses it
 * did read even when another address is unreadable, or one bad RPC response would mask a real
 * mismatch (see `verifyCode`).
 */
export type CodeHashReader = (address: string) => Promise<string | undefined>;

export interface RiskGate {
  /** Current safety state; `HALTED` blocks every action until `resume()`. */
  state(): RiskState;
  /** Kill-switch — trip to `HALTED` with a reason. */
  halt(reason: string): void;
  /** Clear `HALTED` and reset the breaker counter. Does *not* clear live in-flight exposure. */
  resume(): void;
  /**
   * Judge one action just before it is submitted, reserving an exposure slot if allowed. This is
   * the *only* way to ask the gate: there is no bare `check()` that reserves a slot and leaves
   * the caller to remember to release it. The caller owes the returned slot exactly one
   * `settle()`, which the type makes hard to forget and impossible to double-count.
   */
  openSlot(action: RiskAction): RiskSlot;
  /** Actions currently in flight (allowed slots not yet settled). */
  inFlight(): number;
  /**
   * Verify the configured contract bytecode hashes and **halt on mismatch** (an upgraded or
   * self-destructed target is treated as compromised). No-op when unconfigured. Kept out of the
   * synchronous per-action path because it needs a chain read; call at boot and on an interval.
   * The gate passes its own configured addresses, so the caller supplies only the read.
   *
   * A *probe* failure (RPC blip) is **not** evidence of compromise, so it rejects rather than
   * halting — the caller should log and let the next tick retry. But a mismatch **anywhere**
   * outranks a probe failure **everywhere**: every address that could be read is judged before
   * any read error is raised.
   */
  verifyCode(read: CodeHashReader): Promise<void>;
}

export interface RiskConfig {
  /** Auto-`HALTED` after this many consecutive failed outcomes. Unset/0 disables. */
  maxConsecutiveFailures?: number;
  /** Block an action whose `expectedProfit` is below this floor. Unset disables. */
  minProfit?: bigint;
  /** Block an action whose data is older than this many ms. Unset disables. */
  maxDataStalenessMs?: number;
  /** Block once this many actions are already in flight (exposure cap). Unset disables. */
  maxInFlight?: number;
  /** `address -> expected keccak256(bytecode)`. Checked by `verifyCode`. Unset disables. */
  expectedCodeHashes?: Record<string, string>;
  /** Start in `HALTED` (cold-start kill-switch). */
  startHalted?: boolean;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}
