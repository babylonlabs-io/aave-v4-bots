import { createPostgresStateStore } from "./postgres";
import type { PersistenceConfig, StateStore } from "./types";

// Public surface of `@repo/persistence`: the `StateStore` port + data types (`./types`), the
// idempotency key helper (`./utils`), the adapters (`./postgres`, `./memory`), and the
// composition-root selector below. One external seam — the database — and nothing else.
//
// Reconciling in-flight intents against the chain lives in `@repo/engine` (`reconcile.ts`): it
// orchestrates this store *and* chain queries, so it belongs to neither seam alone.
export * from "./types";
export { idempotencyKey } from "./utils";
export { type PostgresStoreConfig, createPostgresStateStore } from "./postgres";
// In-memory adapter (non-durable) for dev/tests — production uses `./postgres`.
export { type MemoryStateStore, createMemoryStateStore } from "./memory";

/** Build the `StateStore` a service asks for. */
export function createStateStore(config: PersistenceConfig): StateStore {
  return createPostgresStateStore(config);
}
