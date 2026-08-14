import type { ProposedTx, SafeExecution } from "@repo/execution";
import type { Address, Hex } from "viem";

// Crash-safety seam — the `StateStore` port + its data types. A `StateStore` gives the send path
// durable memory of *what it intended to do*: an idempotency-keyed intent record, so a crash
// mid-submit does not double-send. Adapters (`./postgres`, `./memory`) implement this; the engine
// depends only on these types, never on a driver like `pg`.
//
// The two shapes this store *carries* rather than defines — the proposed transaction and the Safe
// execution wrapping it — come from `@repo/execution`, whose `hashPayload` / `buildSafeExecution`
// are what give them meaning. This store treats both as opaque jsonb, so restating their fields
// here would be a second definition that only the engine's assignments happened to keep in step.
// The import is type-only (erased at build time), so `@repo/execution` is a devDependency and no
// consumer gains a runtime dependency through it.
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
 *   and nothing on chain. An operator `claimProposal`s it (`proposed → claimed`) before signing —
 *   the fence that stops a superseded/expired proposal being broadcast — then `markBroadcast`
 *   (`claimed → submitted`) joins the AUTO path when the tx is on chain. If it is replaced by a
 *   fresher proposal it becomes `superseded`, and if no one actions it before the TTL, `expired`.
 *
 * `claimed` is deliberately NOT in-flight-on-chain: a claimed proposal is spoken-for but has no tx
 * yet, so reconcile must not see it. An abandoned `claimed` is recovered by an operator, never
 * auto-reverted (that would risk a double-broadcast) — see `StateStore.release` / `fail`.
 *
 * Terminal states — `confirmed`, `failed`, `superseded`, `expired` — are all revivable: a later
 * `recordIntent` / `propose` for the same subject may start a fresh attempt.
 */
export type IntentStatus =
  | "proposed"
  | "claimed"
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "superseded"
  | "expired";

/**
 * The four status sets the store's operations partition the lifecycle by. Named once, here,
 * because the split between them is load-bearing and easy to get subtly wrong:
 *
 * - **`LIVE_FOR_DEDUP`** — an intent in one of these blocks a second `recordIntent`/`propose` for
 *   the same subject. It **includes `proposed` and `claimed`**: without that, a MANUAL bot
 *   re-proposes (and re-notifies) a subject already awaiting or mid-signing every poll cycle.
 * - **`IN_FLIGHT_ON_CHAIN`** — the `reconcile()` work-list: intents that may exist ON CHAIN. It
 *   **excludes `proposed` and `claimed`** (neither has a tx), so reconcile — and the nonce fence
 *   that reads the same list — never sees one.
 * - **`AWAITING_OPERATOR`** — the `proposals()` work-list: intents an operator, not the bot, has to
 *   move. Every implementation of that method must agree on it, so both adapters read it here.
 * - **`TERMINAL`** — revivable states a fresh attempt may overwrite.
 *
 * `proposed`/`claimed` are deliberately in the first and not the second: live enough to dedup,
 * invisible to anything that reasons about the chain.
 */
export const LIVE_FOR_DEDUP: readonly IntentStatus[] = [
  "proposed",
  "claimed",
  "pending",
  "submitted",
];
export const IN_FLIGHT_ON_CHAIN: readonly IntentStatus[] = ["pending", "submitted"];
export const AWAITING_OPERATOR: readonly IntentStatus[] = ["proposed", "claimed"];
export const TERMINAL: readonly IntentStatus[] = ["confirmed", "failed", "superseded", "expired"];

/**
 * A Safe execution envelope — the full SafeTx an operator's owners sign, **fixed at claim time** so
 * the hash they sign is exactly what executes and what reconcile later matches. The inner call is the
 * intent's `payload`; the inherited fields are the Safe-specific ones wrapping it. Absent (`null`)
 * for EOA custody.
 *
 * It is exactly what `buildSafeExecution` produced, plus the one field that is ours rather than the
 * SafeTx's — hence the `extends` rather than a restatement of the same fields. A field added to the
 * SafeTx is then inherited here and persisted; restated, it would be dropped in silence by the
 * spread that builds this, leaving a stored envelope that no longer reproduces the hash the owners
 * signed. Once written it is never renegotiated: a second claim would need a fresh proposal.
 */
export interface SafeEnvelope extends SafeExecution {
  /**
   * The chain block height read at claim time. NOT part of the SafeTx / `safeTxHash` — operational
   * metadata that bounds `operator-cli release`'s log scan (from here to `latest`) when it checks
   * whether this exact SafeTx already executed. Not covered by the hash recompute, so a smaller value
   * only widens the scan; it is not security-critical.
   */
  claimBlock: number;
}

/** Why a `claimProposal` CAS did not apply. */
export type ClaimFailure = "not-found" | "not-proposed" | "hash-mismatch";

/**
 * Outcome of `claimProposal`. `claimed: false` carries the current row (if any) so the operator-cli
 * can explain *why* — superseded, expired, already claimed, or a stale hash.
 */
export type ClaimResult =
  | { claimed: true; intent: TxIntent }
  | { claimed: false; reason: ClaimFailure; existing: TxIntent | null };

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
  /** See `TransitionMeta.relayMaxBlock`. `null` for anything not privately submitted. */
  relayMaxBlock: number | null;
  /** The proposed transaction, for a MANUAL intent; `null` for an AUTO one. */
  payload: ProposedTx | null;
  /**
   * Content hash of `payload` — the operator's out-of-band check; `null` for AUTO.
   *
   * **This store treats it as opaque.** It does not compute it: `propose` takes the hash as an
   * argument and stores it verbatim. The canonical encoding that turns a `ProposedTx` into that hash
   * is the producer's contract (`@repo/execution`'s `hashPayload`), and both the producer and
   * `operator-cli` must use the same one. Critically, `jsonb` does **not** preserve byte layout — it
   * may reorder keys and drops an absent `gasLimit` — so recomputation must canonicalize the *parsed
   * object* (sorted keys, explicit optional handling), never the raw stored bytes.
   */
  payloadHash: Hex | null;
  /** The Safe execution envelope, set at `claimProposal` under `safe` custody; `null` otherwise. */
  safeEnvelope: SafeEnvelope | null;
  /** ms epoch. */
  createdAt: number;
  updatedAt: number;
}

// ── What an intent carries ──────────────────────────────────────────────────────────────────────
//
// `TxIntent`'s `nonce`, `txHash` and `safeEnvelope` are nullable because they are filled in as an
// action progresses, so a consumer that needs one has to null-check it. These name the combinations
// that mean something, so a function can say in its signature what it requires instead of taking
// the fields again as arguments its caller has already checked.
//
// Predicates rather than methods: a `TxIntent` is a row, reconstructed from SQL or from a Map, and
// keeping it plain data is what lets both stores hand back the same shape.

/** An intent that got as far as a recorded transaction hash — something exists to look up on chain. */
export type BroadcastIntent = TxIntent & { txHash: Hex };
/** …whose hash is an outer `execTransaction`, with the envelope naming the SafeTx it carried. */
export type SafeIntent = BroadcastIntent & { safeEnvelope: SafeEnvelope };
/** …and one we signed ourselves: a nonce of the bot's own sequence is spoken for by that hash. */
export type SignedIntent = BroadcastIntent & { nonce: number };

export const isBroadcast = (intent: TxIntent): intent is BroadcastIntent => intent.txHash !== null;
export const isSafe = (intent: TxIntent): intent is SafeIntent =>
  isBroadcast(intent) && intent.safeEnvelope !== null;
export const isSigned = (intent: TxIntent): intent is SignedIntent =>
  isBroadcast(intent) && intent.nonce !== null;

/**
 * What a writer believed the row was when it decided — see `StateStore.transition`.
 *
 * Both fields are optional and an absent one is no precondition at all, in either store. That is
 * what lets a caller guard on whichever half it observed: the hash where its evidence is about one
 * specific transaction, the status where it is about the row's place in its lifecycle.
 */
export interface TransitionExpectation {
  /**
   * Only write if the row is still the exact attempt observed, identified by its `updatedAt`.
   *
   * The strictest of the three, and the only one that survives id reuse: status and hash are both
   * null-and-`pending` on a fresh attempt *and* on the revived attempt that replaced it, so a
   * writer holding a stale read cannot tell them apart by anything else.
   */
  updatedAt?: number;
  /** Only write if the row still carries this hash — i.e. it is still the attempt observed. */
  txHash?: Hex;
  /** Only write if the row is still in one of these statuses. */
  status?: readonly IntentStatus[];
}

/** Optional fields attached as an intent moves through its lifecycle. */
export interface TransitionMeta {
  nonce?: number;
  txHash?: Hex;
  error?: string;
  /**
   * Last block the relay may still include this transaction at — its own deadline, or one derived
   * from the declared relay window. Only this releases a privately-submitted nonce.
   */
  relayMaxBlock?: number;
}

/**
 * Outcome of `recordIntent`. `recorded: false` means a **live** intent (pending/submitted)
 * already exists for this key — the caller must not submit a second time.
 */
export type RecordResult =
  | {
      recorded: true;
      id: string;
      /**
       * This attempt's `updatedAt` — the version token that tells it apart from the next one.
       *
       * Ids are reused: a terminal row is revived in place for the next attempt on the same
       * subject, so the id alone identifies a *subject*, not a try at it. A revived row is
       * byte-identical to a fresh one in every field a writer could check — same status, `nonce`
       * and `txHash` both null — which leaves the stamp as the only thing that differs. Pass it
       * back as `TransitionExpectation.updatedAt` to make a write land on the attempt that claimed
       * it or not at all.
       */
      attemptAt: number;
    }
  | { recorded: false; existing: TxIntent };

export interface StateStore {
  /**
   * Claim this schema for one execution identity, or fail if another already owns it.
   *
   * Everything here is scoped to one account by assumption, never by column: the idempotency key
   * carries no signer, `reconcile()` returns every in-flight intent, and the nonce fence reads them
   * as one sequence. Two bots sharing a schema resolve each other's transactions against the wrong
   * nonces — and `PERSISTENCE_SCHEMA` defaults to `bot` for both services, so one shared
   * `DATABASE_URL` does it silently. This makes it a boot failure instead.
   *
   * Called once at startup, before anything else touches the store. Idempotent for the owner.
   */
  bindExecutionIdentity(identity: { chainId: number; address: Address }): Promise<void>;
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
   * Proposals awaiting an operator — `proposed` (needs claiming) + `claimed` (spoken-for, mid-signing)
   * rows, optionally scoped to one `action`. The read-side counterpart to `reconcile()` (which is the
   * on-chain work-list and excludes both). Filters to rows carrying a `payloadHash`, so an AUTO
   * `pending` never leaks in. Ordered oldest first.
   */
  proposals(action?: string): Promise<TxIntent[]>;
  /** One intent by id (idempotency key), or `null`. The single-row read the operator-cli acts on. */
  getIntent(id: string): Promise<TxIntent | null>;
  /**
   * The operator claims a proposal before signing: a guarded compare-and-set `proposed → claimed`.
   * Applies **only** while the row is `proposed` and its `payloadHash` equals `expectedPayloadHash`.
   * This is the fence: a proposal the bot superseded/expired a moment earlier fails here, *before*
   * anything is signed or broadcast. Under `safe` custody the caller passes the `SafeEnvelope` it
   * fixed (nonce + gas/refund + `safeTxHash`); it is persisted so the signed SafeTx is verifiable.
   */
  claimProposal(
    id: string,
    expectedPayloadHash: Hex,
    envelope?: SafeEnvelope
  ): Promise<ClaimResult>;
  /**
   * The operator broadcast a claimed proposal: move it `claimed → submitted` and record its `txHash`
   * (the direct tx for EOA, the `execTransaction` tx for Safe).
   *
   * A guarded compare-and-set: it applies **only** while the row is `claimed`, has no `txHash` yet,
   * and its `payloadHash` still equals `expectedPayloadHash`. Returns `false` if any guard fails — so
   * a stale hash can never be pinned to an intent. Chain-level verification (does this tx match the
   * payload/envelope?) is the caller's job; this enforces the state machine.
   */
  markBroadcast(id: string, txHash: Hex, expectedPayloadHash: Hex): Promise<boolean>;
  /**
   * Recovery: revert a `claimed` proposal back to `proposed` (CAS, guarded on `payloadHash`), clearing
   * its Safe envelope, so it can be re-notified + re-claimed. For an abandoned claim the operator did
   * **not** broadcast — the caller must verify nothing executed on chain (the Safe/EOA nonce has not
   * advanced) BEFORE calling this, or it would invite a double-broadcast. Returns whether it applied.
   */
  release(id: string, expectedPayloadHash: Hex): Promise<boolean>;
  /**
   * Recovery: mark a live non-terminal intent (`proposed`/`claimed`/`pending`/`submitted`) `failed`,
   * reviving its subject for a fresh attempt. The operator's escape hatch for a wedged intent (a
   * dropped tx, an abandoned claim they don't want re-proposed). Returns whether it applied.
   */
  fail(id: string, error?: string): Promise<boolean>;
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
   * caller, which simply does not call this when the operator turned expiry off — the primitive
   * stays honest about what a zero window means.
   */
  expireProposals(ttlMs: number, action?: string): Promise<number>;
  /**
   * Move an intent to a new status, attaching any `meta` (nonce/txHash/error). Returns whether it
   * applied — `false` means `expect` did not hold and the row was left alone.
   *
   * `expect` binds the write to the row the caller observed, because intent ids are **reused**: a
   * terminal row is revived for the next attempt on the same subject, so a late writer would
   * otherwise stamp its outcome onto a transaction it knows nothing about. Chain evidence may
   * correct our reading of the transaction it is about, never of a different one.
   */
  transition(
    id: string,
    to: IntentStatus,
    meta?: TransitionMeta,
    expect?: TransitionExpectation
  ): Promise<boolean>;
  /**
   * Every in-flight (`IN_FLIGHT_ON_CHAIN`) intent — the reconcile work list. Excludes `proposed`
   * (no tx to reconcile).
   *
   * Unscoped: one schema belongs to one execution identity (`bindExecutionIdentity` enforces it),
   * and within that identity an intent belongs to the account, not to the engine that created it.
   * Scoping by action instead would strand any action no engine owns — `approval`.
   */
  reconcile(): Promise<TxIntent[]>;
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
