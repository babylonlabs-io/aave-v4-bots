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
  /**
   * Token outflows this action authorizes. Reserved against the paying account's spendable balance
   * for as long as the action is in flight, so that concurrent engines spending the same account
   * cannot each pass an affordability check against the same balance and collectively overdraw it.
   * Omit when the action moves no tokens.
   *
   * Fails CLOSED: naming an `(owner, token)` whose balance the gate has never been told
   * (`setAvailable`) blocks the action rather than treating it as unlimited.
   */
  spend?: readonly TokenSpend[];
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
  /**
   * A broadcast tx **reverted, but because a competitor already handled the subject** — the
   * position was liquidated, or the vault acquired, by another bot. Like `abandoned`, it releases
   * the slot without feeding the breaker: losing a race is normal competition, not our malfunction.
   * Distinct from `abandoned` (which means no tx went out at all) so the two stay countable apart.
   */
  contended?: boolean;
  /**
   * A tx **was broadcast but its fate is unknown** — the receipt never arrived, or could not be
   * fetched. Breaker-exempt for the same reason as the two above: not knowing is not evidence the
   * chain rejected us, and behind a nonce gap the tx is provably still in the mempool.
   *
   * Kept distinct from `abandoned` because the two differ for **token accounting**. `abandoned`
   * means no tx exists, so its declared `spend` can never happen and is released outright. Here
   * the tx may still mine, so the spend is counted as if it did: under-reporting spendable balance
   * for a cycle only costs us work we could have afforded, while over-reporting overdraws the
   * signer and reverts — which is a genuine failure that *does* feed the breaker. The next balance
   * refresh corrects whichever way it went.
   */
  unresolved?: boolean;
  /**
   * The declared spend **did** leave, even though this action failed by every other measure.
   *
   * Normally a failure implies the tokens stayed put — a reverted transaction transfers nothing —
   * so the reservation is released outright. That inference breaks when the payment can be made by
   * a transaction other than ours: an authorization signed for a permissionless relay can be
   * submitted by anyone, so ours may revert *because* someone else spent our funds with it. Set
   * this to keep the outflow counted against the balance until the next refresh proves otherwise.
   *
   * Orthogonal to the flags above: an action is typically `contended` **and** `spent`, meaning a
   * competitor handled the subject but our money is what paid for it.
   */
  spent?: boolean;
}

/**
 * The balance sheet one outflow is drawn from.
 *
 * `owner` exists because the account paying is not always the account signing. An engine funded
 * through a router spends a treasury's tokens, while another engine in the same process still
 * spends the signer's — two balances, and netting them would let a reservation against one starve
 * or overdraw the other. Under direct funding every owner is simply the signer.
 */
export interface TokenAccount {
  /** The account the tokens leave. */
  owner: string;
  token: string;
}

/** One token outflow an action authorizes, reserved against `owner`'s balance while in flight. */
export interface TokenSpend extends TokenAccount {
  /** WORST CASE the tx may transfer — the slippage ceiling, or the buffered repay amount. */
  amount: bigint;
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
   * The configured profit floor, or `undefined` when unset.
   *
   * Exposed because the gate's own check happens *before* the transaction is sent and stops
   * constraining anything once it is in the mempool. An execution path that can carry a floor
   * on-chain — flash funding writes one into `minWbtcProfit` — needs to read this to keep the
   * operator's declared minimum true at execution rather than only at admission.
   */
  minProfit(): bigint | undefined;
  /**
   * Tell the gate `owner`'s spendable balance of `token`, from a fresh chain read. Authoritative:
   * it replaces the previous figure and clears what the gate had counted as spent since the last
   * one, so drift from inflows (liquidation payouts, redemptions, transfers in) self-corrects every
   * time it is called. Engines call it once per cycle for each account/token pair they spend.
   */
  setAvailable(account: TokenAccount, amount: bigint): void;
  /** Declared spend currently reserved by in-flight actions, per account/token — logs and metrics. */
  reserved(account: TokenAccount): bigint;
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
  /**
   * Called when the gate changes state — a kill-switch halt, a tripped breaker, a code-hash
   * mismatch, or a resume. Services point this at a `Notifier`.
   *
   * A plain callback, not a notifier, so `@repo/risk` keeps depending on nothing (the same reason
   * `verifyCode` takes a `CodeHashReader` function rather than importing `@repo/chain`). It is
   * invoked synchronously and its failures are swallowed: alerting is advisory, and an alerting
   * bug must never be able to stop the kill-switch from halting.
   */
  onEvent?: RiskEventSink;
}

/** A change in the gate's trading state, worth telling an operator about. */
export type RiskEvent = { kind: "halted"; reason: string } | { kind: "resumed" };

export type RiskEventSink = (event: RiskEvent) => void;
