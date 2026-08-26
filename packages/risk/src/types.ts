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
  /**
   * When the source data was produced (ms epoch) — checked against `maxDataStalenessMs`.
   *
   * Typed `number`, but it reaches callers from an unauthenticated indexer response that is cast
   * rather than parsed, so the gate re-establishes that here instead of trusting it: anything that
   * is not a safe integer, and anything dated more than `MAX_SOURCE_CLOCK_SKEW_MS` in the future,
   * blocks the action.
   */
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
  /**
   * Whether the declared spend left **could not be determined** — the read that answers it failed.
   *
   * Accounted exactly like `spent`, because between "it left" and "it did not" the safe answer is
   * the first: counting an outflow that never happened costs a cycle of work we could have
   * afforded, while missing one that did lets the same balance be committed twice.
   *
   * Distinct from `unresolved`, which is about the *transaction's* fate and is breaker-exempt for
   * that reason. Here the transaction's fate is known — it reverted — and only the money is in
   * doubt, so this flag says nothing about whether the action was a failure. Set it alongside
   * whichever classification is established.
   */
  spendUnknown?: boolean;
  /**
   * The transaction that carries this action's declared spend, once one has been broadcast.
   *
   * It is what the gate holds an unconfirmed outflow *by*, and it has to be the transaction hash
   * rather than the intent id: an intent id names a **subject**, and its row is revived in place
   * for the next attempt (see `StateStore.recordIntent`), so the same id can denote two different
   * transactions and a hold retired for one would free the other's money.
   */
  txHash?: string;
  /**
   * The block the transaction was mined in, when a receipt said so.
   *
   * Lets the hold be retired without asking the chain again: any balance read at or after this
   * height already reports whatever the transaction moved. Absent means "we do not know it mined",
   * which is not the same as "it did not" — an `unresolved` outcome is exactly that state.
   */
  minedAtBlock?: bigint;
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
  /**
   * Who keeps counting this outflow once the slot settles — see `RiskGate.setAvailable`.
   *
   * `gate` (default) is the ordinary case: the transaction *is* the authorization, so once it is
   * broadcast the gate holds the amount until the chain says what became of it.
   *
   * `caller` says the funding mode has its own accounting and the gate must not hold the amount a
   * second time. Router funding signs the payment separately from the transaction: the batch stays
   * live after our transaction resolves — until it is observed executing or its deadline passes —
   * so it outlives the transaction the gate can see, and `RouterFunding` publishes a balance
   * already net of it. Holding it here as well would subtract it twice.
   */
  accounting?: "gate" | "caller";
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
  /**
   * Why the gate is HALTED, or `""` while RUNNING.
   *
   * Exposed because `halt()` alerts only on the RUNNING → HALTED transition, so a *later* cause is
   * recorded silently — and an operator deciding whether to resume needs to know which one they are
   * looking at. `GET /status` serves this for exactly that reason.
   */
  haltReason(): string;
  /** Kill-switch — trip to `HALTED` with a reason. */
  halt(reason: string): void;
  /**
   * Clear `HALTED` and reset the breaker counter. Does *not* clear live in-flight exposure.
   *
   * Returns `false` — refusing, and leaving the gate HALTED — while the halt came from the
   * code-hash guard. A manual halt is an operator's own decision to reverse; "the pinned bytecode
   * is wrong, or has never been readable" is not, and clearing it by hand is what turns a
   * configured control into a formality. That cause clears itself the moment a `verifyCode` passes.
   */
  resume(): boolean;
  /**
   * Has every pinned address passed `verifyCode` at least once in this process?
   *
   * `false` until the first clean pass — and also `false` when nothing is pinned, because there is
   * no verification to have passed. It is the reason a probe failure cannot be shrugged off: the
   * periodic guard is allowed to fail open only because the target was verified *before* — read
   * `guard.ts`. Says nothing about freshness; that is what the check interval is for.
   */
  everVerified(): boolean;
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
   * it replaces the previous figure, so drift from inflows (liquidation payouts, redemptions,
   * transfers in) self-corrects every time it is called. Engines call it once per cycle for each
   * account/token pair they spend.
   *
   * What it does **not** clear is a hold: an outflow whose transaction is broadcast but whose fate
   * the chain has not yet settled is still owed by this balance, and a read taken while that
   * transaction is un-mined reports the money as if it were still there. Those are released by
   * `retireOutflow`, on evidence, never by the passage of a refresh.
   *
   * `block` is the height the read was taken at. Supply it: two engines refresh the same account
   * concurrently and the last writer wins, so without it a read taken earlier can overwrite a
   * later one and raise capacity with no inflow behind it. A snapshot older than the newest one
   * already accepted for that account is ignored.
   */
  setAvailable(account: TokenAccount, amount: bigint, block?: bigint): void;
  /**
   * Outflows the gate is still holding — broadcast transactions whose effect on the balance is not
   * yet proven. The caller is the only party that can settle them: the gate is synchronous and
   * reads no chain.
   *
   * `minedAtBlock` is set when a receipt already told us the height, so a refresh at or past it can
   * retire the hold with no further RPC.
   */
  outflows(): readonly { txHash: string; minedAtBlock?: bigint }[];
  /**
   * Release a held outflow, because a balance read that accounts for it is about to be published.
   *
   * Only two things are evidence: a receipt at or below the height of that read (the money moved,
   * or the transaction reverted and it did not — either way the read is the truth), or a transaction
   * the chain no longer has any way to include. Elapsed time is not evidence, and never retires a
   * hold: a claim on this balance does not expire because a timer did.
   *
   * Call it in the same synchronous step as the `setAvailable` it belongs to, so no action can be
   * judged against a balance that has dropped the hold but not yet gained the fresh read.
   */
  retireOutflow(txHash: string): void;
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
