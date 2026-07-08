import type { Address, Hex } from "viem";
import { type PostgresStoreConfig, createPostgresStateStore } from "./postgres";

// Crash-safety seam. A `StateStore` gives the send path durable memory: a persisted nonce
// lease (so sequencing survives a restart) and an idempotency-keyed intent record (so a
// crash mid-submit does not double-send). The port lives here; the first adapter is
// Postgres (`./postgres`). The engine depends only on this interface, never on `pg`.
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
  /** All in-flight (`pending`/`submitted`) intents — the boot-time reconcile work list. */
  reconcile(): Promise<TxIntent[]>;
  /** Release the underlying connection pool. */
  close(): Promise<void>;
}

/**
 * Deterministic idempotency key for an action. Addresses are lower-cased so a checksum vs.
 * non-checksum spelling of the same address maps to one key. Fields are colon-joined; none
 * of them (chain id, hex address, action label, hex/id subject) contains a colon.
 */
export function idempotencyKey(input: IntentInput): string {
  return `${input.chainId}:${input.target.toLowerCase()}:${input.action}:${input.subject.toLowerCase()}`;
}

// ── Boot-time reconcile ──────────────────────────────────────────────────────────────

/** The chain reads reconcile needs — a structural subset a viem `PublicClient` satisfies. */
export interface ChainReader {
  /** Receipt status for `hash`, or `null` if the receipt is not found yet. */
  getReceiptStatus(hash: Hex): Promise<"success" | "reverted" | null>;
  /** Transaction count for `address` at `latest` (mined) or `pending` (mined + mempool). */
  getNonce(address: Address, tag: "latest" | "pending"): Promise<number>;
}

export interface ReconcileSummary {
  /** In-flight intents examined. */
  examined: number;
  confirmed: number;
  failed: number;
  /** Left in-flight (genuinely still pending on chain). */
  stillInFlight: number;
}

interface ReconcileLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Resolve the store's in-flight intents against the chain, **before** the engine re-drives
 * on boot — the crux of no-double-submit after a crash. `signer` is the sending address
 * whose nonce sequence anchors the "was this broadcast?" checks.
 *
 * Per intent:
 * - **has a tx hash** → look up the receipt: `success` → `confirmed`, `reverted` → `failed`;
 *   no receipt but the signer's mined nonce has already passed the intent's nonce → the tx
 *   was dropped/replaced → `failed`; otherwise it is genuinely pending → left in-flight.
 * - **no hash, but a reserved nonce the chain has mined past** (`latest > nonce`) → a tx took
 *   that nonce slot; we can't fetch a receipt without the hash, so mark `failed` and let the
 *   engine's fresh simulation be the final guard (an already-executed action reverts in
 *   simulation and is skipped; a still-open one is re-driven).
 * - **no hash, reserved nonce still only in the mempool** (`pending > nonce >= latest`) → a
 *   broadcast we did not finish recording is likely in flight; keep it live (marked
 *   `submitted`) so this boot does **not** re-drive it — a later boot resolves it once mined.
 * - **never broadcast** (no nonce, or `pending <= nonce`) → `failed`, safe to re-drive.
 */
export async function reconcilePending(args: {
  store: StateStore;
  reader: ChainReader;
  signer: Address;
  logger?: ReconcileLogger;
}): Promise<ReconcileSummary> {
  const { store, reader, signer, logger } = args;
  const inflight = await store.reconcile();
  const summary: ReconcileSummary = {
    examined: inflight.length,
    confirmed: 0,
    failed: 0,
    stillInFlight: 0,
  };
  if (inflight.length === 0) return summary;

  const [latest, pending] = await Promise.all([
    reader.getNonce(signer, "latest"),
    reader.getNonce(signer, "pending"),
  ]);

  for (const intent of inflight) {
    const { id, nonce, txHash } = intent;

    if (txHash) {
      const status = await reader.getReceiptStatus(txHash);
      if (status === "success") {
        await store.transition(id, "confirmed", { txHash });
        summary.confirmed++;
      } else if (status === "reverted") {
        await store.transition(id, "failed", { txHash, error: "reverted (reconciled)" });
        summary.failed++;
      } else if (nonce !== null && latest > nonce) {
        await store.transition(id, "failed", { txHash, error: "dropped/replaced (reconciled)" });
        summary.failed++;
      } else {
        summary.stillInFlight++;
      }
      continue;
    }

    if (nonce !== null && latest > nonce) {
      // A tx already occupies this nonce; without the hash we resolve to failed and lean on
      // the engine's on-chain simulation to avoid re-executing an already-done action.
      await store.transition(id, "failed", { error: "nonce mined without recorded hash" });
      summary.failed++;
    } else if (nonce !== null && pending > nonce) {
      // Likely in the mempool — keep it live so this boot does not re-drive it.
      await store.transition(id, "submitted", { error: "broadcast unconfirmed on boot" });
      summary.stillInFlight++;
    } else {
      await store.transition(id, "failed", { error: "not broadcast (reconciled)" });
      summary.failed++;
    }
  }

  logger?.info(
    `Reconcile: ${summary.examined} in-flight → ${summary.confirmed} confirmed, ` +
      `${summary.failed} failed, ${summary.stillInFlight} still in-flight`
  );
  return summary;
}

// ── Composition-root selector ──────────────────────────────────────────────────────────

/** How a service is configured to obtain its `StateStore`. Postgres is the only backend. */
export interface PersistenceConfig {
  /** Postgres connection string (e.g. `DATABASE_URL`). */
  connectionString: string;
  /** Schema the bot tables live in (isolated from the indexer's tables). Default `bot`. */
  schema?: string;
}

export { type PostgresStoreConfig, createPostgresStateStore };

/** Build the `StateStore` a service asks for. */
export function createStateStore(config: PersistenceConfig): StateStore {
  return createPostgresStateStore(config);
}
