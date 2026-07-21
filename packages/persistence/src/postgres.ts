import pg from "pg";
import type { Address, Hex } from "viem";
import {
  IN_FLIGHT_ON_CHAIN,
  type IntentInput,
  type IntentStatus,
  type PersistenceConfig,
  type ProposedTx,
  type RecordResult,
  type StateStore,
  TERMINAL,
  type TransitionMeta,
  type TxIntent,
} from "./types";
import { idempotencyKey } from "./utils";

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

/** A Postgres identifier we interpolate (schema name) must be a plain, safe identifier. */
const SCHEMA_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type IntentRow = {
  id: string;
  chain_id: string;
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
  created_at: string;
  updated_at: string;
};

function mapIntent(row: IntentRow): TxIntent {
  return {
    id: row.id,
    chainId: Number(row.chain_id),
    target: row.target as Address,
    action: row.action,
    subject: row.subject,
    status: row.status,
    nonce: row.nonce === null ? null : Number(row.nonce),
    txHash: row.tx_hash === null ? null : (row.tx_hash as Hex),
    error: row.error,
    payload: row.payload,
    payloadHash: row.payload_hash === null ? null : (row.payload_hash as Hex),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INTENT_COLUMNS =
  "id, chain_id, target, action, subject, status, nonce, tx_hash, error, payload, payload_hash, created_at, updated_at";

/** A status set rendered as a SQL list literal — the single source is the exported const array. */
const sqlList = (statuses: readonly string[]) => statuses.map((s) => `'${s}'`).join(", ");
/** Terminal statuses a `recordIntent`/`propose` may revive from. */
const TERMINAL_SQL = sqlList(TERMINAL);
/** In-flight-on-chain statuses the reconcile work-list returns (excludes `proposed`). */
const IN_FLIGHT_SQL = sqlList(IN_FLIGHT_ON_CHAIN);

export function createPostgresStateStore(config: PostgresStoreConfig): StateStore {
  const schema = config.schema ?? "bot";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid persistence schema name: "${schema}"`);
  }
  const intents = `${schema}.tx_intents`;

  const client: PgClientLike =
    config.client ?? (new pg.Pool({ connectionString: config.connectionString }) as PgClientLike);

  // Lazy, once-only schema creation — memoized so every op can `await ready` cheaply.
  let ready: Promise<void> | undefined;
  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = client
        .query(
          `CREATE SCHEMA IF NOT EXISTS ${schema};
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
             created_at BIGINT NOT NULL,
             updated_at BIGINT NOT NULL
           );
           CREATE INDEX IF NOT EXISTS tx_intents_status_idx ON ${intents} (status);
           -- Additive migration for databases created before the MANUAL proposal columns existed.
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS payload JSONB;
           ALTER TABLE ${intents} ADD COLUMN IF NOT EXISTS payload_hash TEXT;`
        )
        .then(() => undefined)
        .catch((error) => {
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
       VALUES ($1, $2, $3, $4, $5, $7, NULL, NULL, NULL, $8, $9, $6, $6)
       ON CONFLICT (id) DO UPDATE
         SET status = $7, nonce = NULL, tx_hash = NULL, error = NULL,
             payload = $8, payload_hash = $9, updated_at = $6
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
    if (res.rows.length > 0) return { recorded: true, id };

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
      return record(input, "proposed", payload, payloadHash);
    },

    async markBroadcast(id, txHash, expectedPayloadHash) {
      await ensureReady();
      // Compare-and-set: apply only while still awaiting broadcast (`proposed`, no hash) and only if
      // the payload the operator verified is still the one on record. A superseded/expired/reported
      // row fails the WHERE and updates nothing.
      const res = await client.query(
        `UPDATE ${intents}
           SET status = 'submitted', tx_hash = $2, updated_at = $4
         WHERE id = $1 AND status = 'proposed' AND tx_hash IS NULL AND payload_hash = $3`,
        [id, txHash, expectedPayloadHash, Date.now()]
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

    async expireProposals(ttlMs, action) {
      await ensureReady();
      const res = await client.query(
        `UPDATE ${intents} SET status = 'expired', updated_at = $1
         WHERE status = 'proposed' AND updated_at <= $2 AND ($3::text IS NULL OR action = $3)`,
        [Date.now(), Date.now() - ttlMs, action ?? null]
      );
      return res.rowCount ?? 0;
    },

    async transition(id: string, to: IntentStatus, meta?: TransitionMeta) {
      await ensureReady();
      await client.query(
        `UPDATE ${intents} SET
           status = $2,
           nonce = COALESCE($3, nonce),
           tx_hash = COALESCE($4, tx_hash),
           error = COALESCE($5, error),
           updated_at = $6
         WHERE id = $1`,
        [id, to, meta?.nonce ?? null, meta?.txHash ?? null, meta?.error ?? null, Date.now()]
      );
    },

    async reconcile(action?: string) {
      await ensureReady();
      const res = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents}
         WHERE status IN (${IN_FLIGHT_SQL}) AND ($1::text IS NULL OR action = $1)
         ORDER BY created_at ASC`,
        [action ?? null]
      );
      return res.rows.map(mapIntent);
    },

    close() {
      return client.end();
    },
  };
}
