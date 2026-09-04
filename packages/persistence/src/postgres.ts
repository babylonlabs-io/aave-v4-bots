import type { ProposedTx } from "@repo/execution";
import pg from "pg";
import type { Address, Hex } from "viem";
import {
  AWAITING_OPERATOR,
  IN_FLIGHT_ON_CHAIN,
  type IntentInput,
  type IntentStatus,
  type PersistenceConfig,
  type RecordResult,
  type SafeEnvelope,
  type StateStore,
  TERMINAL,
  type TxIntent,
} from "./types";
import { assertProposalChain, idempotencyKey } from "./utils";

// `@repo/persistence` `./postgres` adapter — the durable `StateStore` backend. Tables live
// in a dedicated schema (default `bot`) so they never collide with the indexer's tables in
// the same database. The schema + tables are created lazily on first use (`CREATE ... IF NOT
// EXISTS`), so a fresh database needs no migration step.

/**
 * Minimal structural view of the `pg` `Pool` — only `query` and `end`. Lets tests inject a
 * fake and keeps the rest of the package free of the driver's surface. Postgres returns
 * `BIGINT` columns as strings; the row mappers coerce them back to `number`.
 */
export interface PgClientLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface PostgresStoreConfig extends PersistenceConfig {
  /** Injectable client — for tests or custom pool config. Defaults to a `pg.Pool`. */
  client?: PgClientLike;
}

/**
 * Deadlines on the default pool, because a store write runs inside the nonce allocator's lock.
 *
 * `crashSafety`'s pre-broadcast `markPending` is awaited inside `withNonce`, so a query that never
 * returns holds the per-signer lock and every later send and resync — from both engines — queues
 * behind it. `pg` waits forever by default, and a black-holed TCP connection is the ordinary way to
 * get there: nothing errors, the socket simply never answers.
 *
 * The three cover different halves of that and are deliberately ordered:
 * - `connectionTimeoutMillis` bounds getting a connection at all.
 * - `statement_timeout` is server-side. It bounds execution and lock waiting, and lets Postgres
 *   clean up work whose client has walked away.
 * - `query_timeout` is client-side and is the only one that helps when the server never answers.
 *   It sits **above** `statement_timeout` on purpose: below it, the client would give up first and
 *   the server-side budget would never apply to anything.
 *
 * Generous rather than tight. Every query here is a point read, a CAS update or an indexed scan, so
 * these bound a fault, not normal contention — and a spurious failure inside `markPending` aborts
 * the action before broadcast, which is safe but costs the opportunity.
 */
export const DEFAULT_POOL_TIMEOUTS = {
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
} as const;

/** A Postgres identifier we interpolate (schema name) must be a plain, safe identifier. */
const SCHEMA_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type IntentRow = {
  id: string;
  chain_id: string;
  relay_max_block: string | null;
  target: string;
  action: string;
  subject: string;
  status: IntentStatus;
  nonce: string | null;
  tx_hash: string | null;
  error: string | null;
  // `jsonb` — `pg` already parses it into an object; `null` for AUTO rows.
  payload: ProposedTx | null;
  payload_hash: string | null;
  // `jsonb` — the Safe execution envelope, set at claim under `safe` custody; `null` otherwise.
  safe_envelope: SafeEnvelope | null;
  created_at: string;
  updated_at: string;
};

function mapIntent(row: IntentRow): TxIntent {
  return {
    id: row.id,
    chainId: Number(row.chain_id),
    relayMaxBlock: row.relay_max_block === null ? null : Number(row.relay_max_block),
    target: row.target as Address,
    action: row.action,
    subject: row.subject,
    status: row.status,
    nonce: row.nonce === null ? null : Number(row.nonce),
    txHash: row.tx_hash === null ? null : (row.tx_hash as Hex),
    error: row.error,
    payload: row.payload,
    payloadHash: row.payload_hash === null ? null : (row.payload_hash as Hex),
    safeEnvelope: row.safe_envelope,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INTENT_COLUMNS =
  "id, chain_id, target, action, subject, status, nonce, tx_hash, error, payload, payload_hash, safe_envelope, relay_max_block, created_at, updated_at";

/** A status set rendered as a SQL list literal — the single source is the exported const array. */
const sqlList = (statuses: readonly string[]) => statuses.map((s) => `'${s}'`).join(", ");
/** Terminal statuses a `recordIntent`/`propose` may revive from. */
const TERMINAL_SQL = sqlList(TERMINAL);
/** In-flight-on-chain statuses the reconcile work-list returns (excludes `proposed`/`claimed`). */
const IN_FLIGHT_SQL = sqlList(IN_FLIGHT_ON_CHAIN);
/** Operator-owned, pre-chain proposal states the `proposals()` work-list returns. */
const PROPOSAL_STATES_SQL = sqlList(AWAITING_OPERATOR);

export function createPostgresStateStore(config: PostgresStoreConfig): StateStore {
  const schema = config.schema ?? "bot";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid persistence schema name: "${schema}"`);
  }
  const intents = `${schema}.tx_intents`;
  const owner = `${schema}.execution_owner`;

  const client: PgClientLike =
    config.client ??
    (new pg.Pool({
      connectionString: config.connectionString,
      ...DEFAULT_POOL_TIMEOUTS,
    }) as PgClientLike);

  // Lazy, once-only schema creation — memoized so every op can `await ready` cheaply.
  const initDdl = `CREATE SCHEMA IF NOT EXISTS ${schema};
           CREATE TABLE IF NOT EXISTS ${intents} (
             id TEXT PRIMARY KEY,
             chain_id BIGINT NOT NULL,
             target TEXT NOT NULL,
             action TEXT NOT NULL,
             subject TEXT NOT NULL,
             status TEXT NOT NULL,
             nonce BIGINT,
             tx_hash TEXT,
             error TEXT,
             payload JSONB,
             payload_hash TEXT,
             safe_envelope JSONB,
             created_at BIGINT NOT NULL,
             updated_at BIGINT NOT NULL
           );
           CREATE INDEX IF NOT EXISTS tx_intents_status_idx ON ${intents} (status);
           -- Additive migration for databases created before the MANUAL proposal columns existed.
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS payload JSONB;
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS payload_hash TEXT;
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS safe_envelope JSONB;
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS relay_max_block BIGINT;
           CREATE TABLE IF NOT EXISTS ${owner} (
             lock BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (lock),
             chain_id BIGINT NOT NULL,
             address TEXT NOT NULL,
             bound_at BIGINT NOT NULL
           );`;

  // `CREATE ... IF NOT EXISTS` is NOT concurrency-safe in Postgres: two backends running it at once
  // (e.g. this bot and another process sharing the database, or two engines on first boot) can each
  // pass the existence check and then collide inserting into `pg_namespace`/`pg_class`, raising a
  // duplicate-key error even though the desired end state is idempotent. Retry once on exactly those
  // races: the second run finds the object present and no-ops. Any other error propagates.
  const CONCURRENT_CREATE_CODES = new Set([
    "23505", // unique_violation (pg_namespace / pg_class index)
    "42P06", // duplicate_schema
    "42P07", // duplicate_table
  ]);
  async function runInit(): Promise<void> {
    try {
      await client.query(initDdl);
    } catch (error) {
      if (CONCURRENT_CREATE_CODES.has((error as { code?: string })?.code ?? "")) {
        await client.query(initDdl);
        return;
      }
      throw error;
    }
  }

  let ready: Promise<void> | undefined;
  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = runInit().catch((error) => {
        // Reset so a transient failure (e.g. DB not yet up) is retried on the next call.
        ready = undefined;
        throw error;
      });
    }
    return ready;
  }

  /**
   * Shared insert-or-revive for `recordIntent` (AUTO, `pending`) and `propose` (MANUAL,
   * `proposed`). On conflict it revives only a `TERMINAL` row; a live row (`LIVE_FOR_DEDUP`) fails
   * the WHERE, returns no row, and is reported as a refusal.
   */
  async function record(
    input: IntentInput,
    status: "pending" | "proposed",
    payload: ProposedTx | null,
    payloadHash: Hex | null
  ): Promise<RecordResult> {
    await ensureReady();
    const id = idempotencyKey(input);
    const now = Date.now();
    const payloadJson = payload === null ? null : JSON.stringify(payload);
    const res = await client.query<IntentRow>(
      `INSERT INTO ${intents} AS t
         (${INTENT_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $7, NULL, NULL, NULL, $8, $9, NULL, NULL, $6, $6)
       ON CONFLICT (id) DO UPDATE
         SET status = $7, nonce = NULL, tx_hash = NULL, error = NULL,
             payload = $8, payload_hash = $9, safe_envelope = NULL, relay_max_block = NULL,
             updated_at = $6
         WHERE t.status IN (${TERMINAL_SQL})
       RETURNING ${INTENT_COLUMNS}`,
      [
        id,
        input.chainId,
        input.target.toLowerCase(),
        input.action,
        input.subject,
        now,
        status,
        payloadJson,
        payloadHash,
      ]
    );
    if (res.rows.length > 0) return { recorded: true, id, attemptAt: now };

    const existing = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM ${intents} WHERE id = $1`,
      [id]
    );
    return { recorded: false, existing: mapIntent(existing.rows[0]) };
  }

  return {
    recordIntent(input) {
      return record(input, "pending", null, null);
    },

    propose(input, payload, payloadHash) {
      assertProposalChain(input, payload);
      return record(input, "proposed", payload, payloadHash);
    },

    async proposals(action?: string) {
      await ensureReady();
      const res = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents}
         WHERE status IN (${PROPOSAL_STATES_SQL}) AND payload_hash IS NOT NULL
           AND ($1::text IS NULL OR action = $1)
         ORDER BY created_at ASC`,
        [action ?? null]
      );
      return res.rows.map(mapIntent);
    },

    async getIntent(id: string) {
      await ensureReady();
      const res = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents} WHERE id = $1`,
        [id]
      );
      return res.rows.length > 0 ? mapIntent(res.rows[0]) : null;
    },

    async claimProposal(id, expectedPayloadHash, envelope) {
      await ensureReady();
      // Compare-and-set `proposed → claimed`: the fence. Applies only while still `proposed` and the
      // payload the operator verified is on record. A superseded/expired/already-claimed row fails.
      const res = await client.query<IntentRow>(
        `UPDATE ${intents}
           SET status = 'claimed', safe_envelope = $3, updated_at = $4
         WHERE id = $1 AND status = 'proposed' AND payload_hash = $2
         RETURNING ${INTENT_COLUMNS}`,
        [id, expectedPayloadHash, envelope ? JSON.stringify(envelope) : null, Date.now()]
      );
      if (res.rows.length > 0) return { claimed: true, intent: mapIntent(res.rows[0]) };
      // The CAS matched nothing — read the current row to explain why to the operator.
      const existing = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents} WHERE id = $1`,
        [id]
      );
      if (existing.rows.length === 0)
        return { claimed: false, reason: "not-found", existing: null };
      const row = mapIntent(existing.rows[0]);
      return {
        claimed: false,
        reason: row.status === "proposed" ? "hash-mismatch" : "not-proposed",
        existing: row,
      };
    },

    async markBroadcast(id, txHash, expectedPayloadHash) {
      await ensureReady();
      // Compare-and-set: apply only to a `claimed` proposal (the claim fence ran) still awaiting
      // broadcast, whose verified payload is unchanged. A released/superseded/reported row updates
      // nothing.
      const res = await client.query(
        `UPDATE ${intents}
           SET status = 'submitted', tx_hash = $2, updated_at = $4
         WHERE id = $1 AND status = 'claimed' AND tx_hash IS NULL AND payload_hash = $3`,
        [id, txHash, expectedPayloadHash, Date.now()]
      );
      return (res.rowCount ?? 0) > 0;
    },

    // The envelope deliberately survives. Releasing gives up the *claim*, and a Safe envelope is not
    // part of the claim: once a threshold of owners has signed its hash — off chain, where nothing
    // here can see it — that SafeTx is executable by anyone until its nonce is consumed. Dropping the
    // record would leave that authorization live with nothing pointing at it, and the next claim
    // would reserve a second one over the same payload. `claimProposal` in the operator CLI is what
    // resolves it: the same envelope while its nonce stands, a new one only once the old is provably
    // dead. See `expireProposals`, which for the same reason will not sweep a row still carrying one.
    async release(id, expectedPayloadHash) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET status = 'proposed', updated_at = $3
         WHERE id = $1 AND status = 'claimed' AND payload_hash = $2`,
        [id, expectedPayloadHash, Date.now()]
      );
      return (res.rowCount ?? 0) > 0;
    },

    async fail(id, error) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET status = 'failed', error = COALESCE($2, error), updated_at = $3
         WHERE id = $1 AND status IN ('proposed', 'claimed', 'pending', 'submitted')`,
        [id, error ?? null, Date.now()]
      );
      return (res.rowCount ?? 0) > 0;
    },

    async supersede(id) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET status = 'superseded', updated_at = $2
         WHERE id = $1 AND status = 'proposed'`,
        [id, Date.now()]
      );
      return (res.rowCount ?? 0) > 0;
    },

    // A row still carrying a Safe envelope is never swept. Expiry is a *timer*, and a signed SafeTx
    // does not expire with it — the authorization stays executable until its nonce is consumed. Left
    // to the timer, the row would go terminal and the next proposal for the subject would revive it,
    // clearing the envelope (see `recordIntent`) and taking with it the only record of what is still
    // outstanding. The row stays until an operator resolves it.
    async expireProposals(ttlMs, action) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET status = 'expired', updated_at = $1
         WHERE status = 'proposed' AND safe_envelope IS NULL AND updated_at <= $2
           AND ($3::text IS NULL OR action = $3)`,
        [Date.now(), Date.now() - ttlMs, action ?? null]
      );
      return res.rowCount ?? 0;
    },

    async transition(id, to, meta, expect) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET
           status = $2,
           nonce = COALESCE($3, nonce),
           tx_hash = COALESCE($4, tx_hash),
           error = COALESCE($5, error),
           relay_max_block = COALESCE($9, relay_max_block),
           updated_at = $6
         WHERE id = $1
           AND ($7::text IS NULL OR tx_hash = $7)
           AND ($8::text[] IS NULL OR status = ANY($8))
           AND ($10::bigint IS NULL OR updated_at = $10)`,
        [
          id,
          to,
          meta?.nonce ?? null,
          meta?.txHash ?? null,
          meta?.error ?? null,
          Date.now(),
          expect?.txHash ?? null,
          expect?.status ? [...expect.status] : null,
          meta?.relayMaxBlock ?? null,
          expect?.updatedAt ?? null,
        ]
      );
      return (res.rowCount ?? 0) > 0;
    },

    async bindExecutionIdentity({ chainId, address }) {
      await ensureReady();
      // Claim-or-read in one statement: `DO NOTHING` leaves an existing owner untouched, and the
      // follow-up read tells us whether it is us. A check-then-write would race two bots starting
      // together — the exact situation this guards.
      await client.query(
        `INSERT INTO ${owner} (lock, chain_id, address, bound_at)
         VALUES (TRUE, $1, $2, $3) ON CONFLICT (lock) DO NOTHING`,
        [chainId, address.toLowerCase(), Date.now()]
      );
      const res = await client.query<{ chain_id: string; address: string }>(
        `SELECT chain_id, address FROM ${owner} WHERE lock`
      );
      const held = res.rows[0];
      if (held && (Number(held.chain_id) !== chainId || held.address !== address.toLowerCase())) {
        throw new Error(
          `persistence schema "${schema}" is bound to ${held.chain_id}:${held.address}, but this process executes as ${chainId}:${address.toLowerCase()}. Intents in one schema are keyed and reconciled as a single account, so sharing it across signers resolves each other's transactions against the wrong nonces. Give this service its own PERSISTENCE_SCHEMA (or its own DATABASE_URL).`
        );
      }
    },

    async reconcile() {
      await ensureReady();
      const res = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents}
         WHERE status IN (${IN_FLIGHT_SQL})
         ORDER BY created_at ASC`
      );
      return res.rows.map(mapIntent);
    },

    close() {
      return client.end();
    },
  };
}
