import type { Address } from "viem";
import type {
  IntentInput,
  IntentStatus,
  RecordResult,
  StateStore,
  TransitionMeta,
  TxIntent,
} from "./types";
import { idempotencyKey } from "./utils";

// In-memory `StateStore` — **non-durable**, for dev and tests (production uses `./postgres`).
// Mirrors the Postgres adapter's semantics exactly: idempotency refuse/revive, a per-address
// nonce lease, and the action-filtered reconcile work-list. Having one canonical fake avoids
// each test re-implementing (and drifting) its own.

/** A `StateStore` with in-memory introspection helpers for assertions. */
export interface MemoryStateStore extends StateStore {
  /** Every intent, any status. */
  all(): TxIntent[];
  /** One intent by id (idempotency key), or `undefined`. */
  get(id: string): TxIntent | undefined;
}

/** Build a non-durable in-memory `StateStore`. */
export function createMemoryStateStore(): MemoryStateStore {
  const rows = new Map<string, TxIntent>();
  const leases = new Map<string, number>();
  const live: IntentStatus[] = ["pending", "submitted"];

  return {
    all: () => [...rows.values()],
    get: (id) => rows.get(id),

    async reserveNonce(address: Address) {
      const key = address.toLowerCase();
      const value = leases.get(key);
      if (value === undefined) {
        throw new Error(`nonce lease for ${address} is not seeded (call syncNonce first)`);
      }
      leases.set(key, value + 1);
      return value;
    },

    async syncNonce(address: Address, chainNonce: number) {
      leases.set(address.toLowerCase(), chainNonce);
    },

    async recordIntent(input: IntentInput): Promise<RecordResult> {
      const id = idempotencyKey(input);
      const existing = rows.get(id);
      if (existing && live.includes(existing.status)) {
        return { recorded: false, existing };
      }
      const now = Date.now();
      rows.set(id, {
        id,
        ...input,
        status: "pending",
        nonce: null,
        txHash: null,
        error: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return { recorded: true, id };
    },

    async transition(id: string, to: IntentStatus, meta?: TransitionMeta) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, {
        ...row,
        status: to,
        nonce: meta?.nonce ?? row.nonce,
        txHash: meta?.txHash ?? row.txHash,
        error: meta?.error ?? row.error,
        updatedAt: Date.now(),
      });
    },

    async reconcile(action?: string) {
      return [...rows.values()].filter(
        (r) => live.includes(r.status) && (action === undefined || r.action === action)
      );
    },

    async close() {},
  };
}
