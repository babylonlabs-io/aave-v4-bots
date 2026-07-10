import type { Address, Hex } from "viem";

// Crash-safety seam — the `StateStore` port + its data types. A `StateStore` gives the send
// path durable memory: a persisted nonce lease (so sequencing survives a restart) and an
// idempotency-keyed intent record (so a crash mid-submit does not double-send). Adapters
// (`./postgres`, `./memory`) implement this; the engine depends only on these types, never on
// a driver like `pg`.
//
// **Single-active-instance assumption:** the nonce lease is authoritative for one running
// process per signing key. Multi-instance leasing (advisory locks / row leases) is a later
// adapter concern; this first cut targets the single-bot deployment.

/** Lifecycle of one intended on-chain action. Terminal states: `confirmed`, `failed`. */
export type IntentStatus = "pending" | "submitted" | "confirmed" | "failed";

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
  /** Reserved nonce, once allocated. */
  nonce: number | null;
  /** Broadcast tx hash, once submitted. */
  txHash: Hex | null;
  /** Failure detail, if any. */
  error: string | null;
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
   * Allocate the next nonce for `address` and durably advance the lease. Requires the lease
   * to have been seeded via `syncNonce` (typically at boot). Throws if unseeded.
   */
  reserveNonce(address: Address): Promise<number>;
  /**
   * Set the lease for `address` to `chainNonce` (the chain's next expected nonce). Used to
   * seed at boot and to re-align after a send failure. Unconditional set — safe under the
   * single-active-instance assumption.
   */
  syncNonce(address: Address, chainNonce: number): Promise<void>;
  /**
   * Record an intent as `pending`. Refuses (`recorded: false`) if a live intent already
   * exists for the same `(chainId, target, action, subject)`; revives a terminal one.
   */
  recordIntent(input: IntentInput): Promise<RecordResult>;
  /** Move an intent to a new status, attaching any `meta` (nonce/txHash/error). */
  transition(id: string, to: IntentStatus, meta?: TransitionMeta): Promise<void>;
  /**
   * In-flight (`pending`/`submitted`) intents — the reconcile work list. Optionally filtered
   * to a single `action` so an engine reconciles only its own intents (the arbitrageur's two
   * engines share one store but own distinct actions).
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
