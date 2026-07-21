import pg from "pg";
import type { Address, Hex } from "viem";
import type {
  IntentInput,
  IntentStatus,
  PersistenceConfig,
  RecordResult,
  StateStore,
  TransitionMeta,
  TxIntent,
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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INTENT_COLUMNS =
  "id, chain_id, target, action, subject, status, nonce, tx_hash, error, created_at, updated_at";

export function createPostgresStateStore(config: PostgresStoreConfig): StateStore {
  const schema = config.schema ?? "bot";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid persistence schema name: "${schema}"`);
  }
  const intents = `${schema}.tx_intents`;
  const leases = `${schema}.nonce_leases`;

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
             created_at BIGINT NOT NULL,
             updated_at BIGINT NOT NULL
           );
           CREATE INDEX IF NOT EXISTS tx_intents_status_idx ON ${intents} (status);
           CREATE TABLE IF NOT EXISTS ${leases} (
             address TEXT PRIMARY KEY,
             next_nonce BIGINT NOT NULL,
             updated_at BIGINT NOT NULL
           );`
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

  return {
    async reserveNonce(address) {
      await ensureReady();
      const key = address.toLowerCase();
      const res = await client.query<{ allocated: string }>(
        `UPDATE ${leases} SET next_nonce = next_nonce + 1, updated_at = $2
         WHERE address = $1 RETURNING next_nonce - 1 AS allocated`,
        [key, Date.now()]
      );
      if (res.rows.length === 0) {
        throw new Error(`nonce lease for ${address} is not seeded (call syncNonce first)`);
      }
      return Number(res.rows[0].allocated);
    },

    async syncNonce(address, chainNonce) {
      await ensureReady();
      const key = address.toLowerCase();
      await client.query(
        `INSERT INTO ${leases} (address, next_nonce, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (address) DO UPDATE SET next_nonce = $2, updated_at = $3`,
        [key, chainNonce, Date.now()]
      );
    },

    async recordIntent(input: IntentInput): Promise<RecordResult> {
      await ensureReady();
      const id = idempotencyKey(input);
      const now = Date.now();
      // Insert as pending; on conflict, only *revive* a terminal (confirmed/failed) row. A
      // live (pending/submitted) row fails the WHERE, so the statement returns no row — the
      // signal that a second submit must be refused.
      const res = await client.query<IntentRow>(
        `INSERT INTO ${intents} AS t
           (${INTENT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, 'pending', NULL, NULL, NULL, $6, $6)
         ON CONFLICT (id) DO UPDATE
           SET status = 'pending', nonce = NULL, tx_hash = NULL, error = NULL, updated_at = $6
           WHERE t.status IN ('confirmed', 'failed')
         RETURNING ${INTENT_COLUMNS}`,
        [id, input.chainId, input.target.toLowerCase(), input.action, input.subject, now]
      );
      if (res.rows.length > 0) return { recorded: true, id };

      const existing = await client.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM ${intents} WHERE id = $1`,
        [id]
      );
      return { recorded: false, existing: mapIntent(existing.rows[0]) };
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
         WHERE status IN ('pending', 'submitted') AND ($1::text IS NULL OR action = $1)
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
