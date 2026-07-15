import type { Address, Hex } from "viem";

// Crash-safety seam — the `StateStore` port + its data types. A `StateStore` gives the send path
// durable memory of *what it intended to do*: an idempotency-keyed intent record, so a crash
// mid-submit does not double-send. Adapters (`./postgres`, `./memory`) implement this; the engine
// depends only on these types, never on a driver like `pg`.
//
// Its scope is intent idempotency and the reconcile work-list. Nonce ownership belongs to
// `@repo/execution`'s `NonceLease` / `NonceAllocator`, re-seeded from the chain each cycle.
//
// **Single-active-instance assumption:** one running process per signing key. Multi-instance
// coordination (advisory locks / row leases) is a later adapter concern; this first cut targets
// the single-bot deployment.

/**
 * Lifecycle of one intended on-chain action.
 *
 * Two entry points, by execution mode:
 * - **AUTO** starts at `pending` (nonce + hash recorded pre-broadcast) → `submitted` (broadcast
 *   attempted) → `confirmed` / `failed`.
 * - **MANUAL** starts at `proposed` — a transaction written down for a human to sign, with no nonce
 *   and nothing on chain. When the operator broadcasts it (`markBroadcast`) it joins the AUTO path
 *   at `submitted`; if it is replaced by a fresher proposal it becomes `superseded`, and if no one
 *   actions it before the TTL it becomes `expired`.
 *
 * Terminal states — `confirmed`, `failed`, `superseded`, `expired` — are all revivable: a later
 * `recordIntent` / `propose` for the same subject may start a fresh attempt.
 */
export type IntentStatus =
  | "proposed"
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "superseded"
  | "expired";

/**
 * The three status sets the store's operations partition the lifecycle by. Named once, here,
 * because the split between them is load-bearing and easy to get subtly wrong:
 *
 * - **`LIVE_FOR_DEDUP`** — an intent in one of these blocks a second `recordIntent`/`propose` for
 *   the same subject. It **includes `proposed`**: without that, a MANUAL bot re-proposes (and
 *   re-notifies) the same subject every poll cycle.
 * - **`IN_FLIGHT_ON_CHAIN`** — the `reconcile()` work-list: intents that may exist ON CHAIN. It
 *   **excludes `proposed`** (a proposal has no tx), so reconcile — and the nonce fence that reads
 *   the same list — never sees one.
 * - **`TERMINAL`** — revivable states a fresh attempt may overwrite.
 *
 * `proposed` is deliberately in the first and not the second: live enough to dedup, invisible to
 * anything that reasons about the chain.
 */
export const LIVE_FOR_DEDUP: readonly IntentStatus[] = ["proposed", "pending", "submitted"];
export const IN_FLIGHT_ON_CHAIN: readonly IntentStatus[] = ["pending", "submitted"];
export const TERMINAL: readonly IntentStatus[] = ["confirmed", "failed", "superseded", "expired"];

/**
 * The transaction a MANUAL proposal asks an operator to sign. Every field is JSON-serializable (no
 * `bigint`) — `value`/`gasLimit` are **decimal strings** — because the payload is stored as `jsonb`
 * and rendered by `operator-cli`.
 *
 * **This store treats `payloadHash` as opaque.** It does not compute it: `propose` takes the hash
 * as an argument and stores it verbatim. The canonical encoding that turns a `ProposedTx` into that
 * hash is the *producer's* contract (#9b's `encodeCall` + keccak), and both the producer and
 * `operator-cli` must use the same one. Critically, `jsonb` does **not** preserve byte layout — it
 * may reorder keys and drops an absent `gasLimit` — so recomputation must canonicalize the *parsed
 * object* (sorted keys, explicit optional handling), never the raw stored bytes.
 *
 * `nonce` and fee fields are deliberately absent: they belong to whoever signs (the operator's
 * wallet fills them at broadcast), not to the bot proposing the call.
 */
export interface ProposedTx {
  chainId: number;
  to: Address;
  /** Encoded calldata. */
  data: Hex;
  /** Wei, as a decimal string (`"0"` today). */
  value: string;
  /** Gas limit hint, decimal string — advisory; the signer decides. */
  gasLimit?: string;
}

/** The identity of an action — everything the idempotency key is derived from. */
export interface IntentInput {
  /** Chain the action targets. */
  chainId: number;
  /** Contract the action calls (e.g. the AaveAdapter). */
  target: Address;
  /** What is being attempted — e.g. "liquidation", "vault-acquisition". */
  action: string;
  /** The subject the action acts on (position proxy / vault id). */
  subject: string;
}

/** A persisted intent row. */
export interface TxIntent extends IntentInput {
  /** Idempotency key — `idempotencyKey(input)`. */
  id: string;
  status: IntentStatus;
  /** Reserved nonce, once allocated. `null` for a MANUAL proposal (never signed by the bot). */
  nonce: number | null;
  /** Broadcast tx hash, once submitted (AUTO) or reported by the operator (MANUAL). */
  txHash: Hex | null;
  /** Failure detail, if any. */
  error: string | null;
  /** The proposed transaction, for a MANUAL intent; `null` for an AUTO one. */
  payload: ProposedTx | null;
  /** Opaque content hash of `payload` (the operator's out-of-band check); `null` for AUTO. See `ProposedTx`. */
  payloadHash: Hex | null;
  /** ms epoch. */
  createdAt: number;
  updatedAt: number;
}

/** Optional fields attached as an intent moves through its lifecycle. */
export interface TransitionMeta {
  nonce?: number;
  txHash?: Hex;
  error?: string;
}

/**
 * Outcome of `recordIntent`. `recorded: false` means a **live** intent (pending/submitted)
 * already exists for this key — the caller must not submit a second time.
 */
export type RecordResult = { recorded: true; id: string } | { recorded: false; existing: TxIntent };

export interface StateStore {
  /**
   * Record an AUTO intent as `pending`. Refuses (`recorded: false`) if a **live** intent
   * (`LIVE_FOR_DEDUP`, which now includes MANUAL `proposed`) already exists for the same
   * `(chainId, target, action, subject)`; revives a terminal one.
   */
  recordIntent(input: IntentInput): Promise<RecordResult>;
  /**
   * Record a MANUAL proposal as `proposed`, carrying its `payload` + `payloadHash`. Same dedup as
   * `recordIntent` (refuses against a live intent, revives a terminal one) — so two poll cycles
   * over one subject yield a single proposal. On refusal the returned `existing.payloadHash` lets
   * the caller decide whether to `supersede` it (the payload changed) or leave it (unchanged).
   */
  propose(input: IntentInput, payload: ProposedTx, payloadHash: Hex): Promise<RecordResult>;
  /**
   * The operator broadcast a proposal: move it `proposed → submitted` and record its `txHash`.
   *
   * A guarded compare-and-set, not a blind `transition`: it applies **only** while the row is still
   * `proposed`, has no `txHash` yet, and its `payloadHash` still equals `expectedPayloadHash`.
   * Returns `false` if any guard fails — the proposal was superseded, expired, or already reported —
   * so a stale or unrelated hash can never be pinned to an intent. Chain-level verification (does
   * this tx really match the payload?) is the caller's job; this enforces the state machine.
   */
  markBroadcast(id: string, txHash: Hex, expectedPayloadHash: Hex): Promise<boolean>;
  /**
   * Retire a `proposed` intent as `superseded` (a fresher proposal for the same subject replaces
   * it). No-op unless the row is currently `proposed` — a `pending`/`submitted` (AUTO, real tx)
   * intent is never superseded. Returns whether it applied.
   */
  supersede(id: string): Promise<boolean>;
  /**
   * Sweep `proposed` intents whose `updatedAt` is at least `ttlMs` in the past to `expired`,
   * optionally scoped to one `action`. Returns the count swept. This is the liveness backstop: an
   * un-actioned proposal is live-for-dedup, so without expiry it would block its subject from ever
   * being re-proposed.
   *
   * `ttlMs` is a **mechanical lookback window**, not a policy: `0` sweeps every current proposal
   * (`updatedAt <= now`). The "`MANUAL_INTENT_TTL_MS=0` disables expiry" convention lives in the
   * caller (#9b), which simply does not call this when the operator turned expiry off — the
   * primitive stays honest about what a zero window means.
   */
  expireProposals(ttlMs: number, action?: string): Promise<number>;
  /** Move an intent to a new status, attaching any `meta` (nonce/txHash/error). */
  transition(id: string, to: IntentStatus, meta?: TransitionMeta): Promise<void>;
  /**
   * In-flight (`IN_FLIGHT_ON_CHAIN`) intents — the reconcile work list. Excludes `proposed`
   * (no tx to reconcile). Optionally filtered to a single `action` so an engine reconciles only
   * its own intents (the arbitrageur's two engines share one store but own distinct actions).
   */
  reconcile(action?: string): Promise<TxIntent[]>;
  /** Release the underlying connection pool. */
  close(): Promise<void>;
}

/** How a service is configured to obtain its `StateStore`. Postgres is the only backend. */
export interface PersistenceConfig {
  /** Postgres connection string (e.g. `DATABASE_URL`). */
  connectionString: string;
  /** Schema the bot tables live in (isolated from the indexer's tables). Default `bot`. */
  schema?: string;
}
