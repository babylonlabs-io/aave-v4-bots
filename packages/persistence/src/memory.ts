import type { ProposedTx } from "@repo/execution";
import type { Hex } from "viem";
import {
  AWAITING_OPERATOR,
  IN_FLIGHT_ON_CHAIN,
  type IntentInput,
  type IntentStatus,
  LIVE_FOR_DEDUP,
  type RecordResult,
  type StateStore,
  type TransitionMeta,
  type TxIntent,
} from "./types";
import { assertProposalChain, idempotencyKey } from "./utils";

// In-memory `StateStore` — **non-durable**, for dev and tests (production uses `./postgres`).
// Mirrors the Postgres adapter's semantics exactly: idempotency refuse/revive, the MANUAL proposal
// lifecycle, and the action-filtered reconcile work-list. Having one canonical fake avoids each
// test re-implementing (and drifting) its own.
//
// Every row leaves this store as a **copy** (`clone`). Postgres hands back a fresh object on every
// read, so a caller can never reach through a returned row to mutate stored state; the in-memory
// model must behave the same or a test could pass against a mutation Postgres would reject.

/** A `StateStore` with in-memory introspection helpers for assertions. */
export interface MemoryStateStore extends StateStore {
  /** Every intent, any status (defensive copies). */
  all(): TxIntent[];
  /** One intent by id (idempotency key), or `undefined` (a defensive copy). */
  get(id: string): TxIntent | undefined;
}

/** Deep-enough copy: a fresh row + fresh `payload`/`safeEnvelope`, so nothing stored is reachable by ref. */
function clone(row: TxIntent): TxIntent {
  return {
    ...row,
    payload: row.payload === null ? null : { ...row.payload },
    safeEnvelope: row.safeEnvelope === null ? null : { ...row.safeEnvelope },
  };
}

/**
 * Build a non-durable in-memory `StateStore`. `now` is injectable so tests can drive the TTL clock
 * `expireProposals` reads without mutating stored rows (Postgres uses wall-clock; both agree that
 * time only advances between calls).
 */
export function createMemoryStateStore(now: () => number = Date.now): MemoryStateStore {
  const rows = new Map<string, TxIntent>();
  const isLive = (status: IntentStatus) => LIVE_FOR_DEDUP.includes(status);

  /** Shared record/revive: refuse a live intent, else (re)create it in `status`. */
  function record(
    input: IntentInput,
    status: "pending" | "proposed",
    payload: ProposedTx | null,
    payloadHash: Hex | null
  ): RecordResult {
    const id = idempotencyKey(input);
    const existing = rows.get(id);
    if (existing && isLive(existing.status)) {
      return { recorded: false, existing: clone(existing) };
    }
    const ts = now();
    rows.set(id, {
      id,
      ...input,
      status,
      nonce: null,
      txHash: null,
      error: null,
      // Copy on store too: the caller must not be able to mutate the payload after proposing.
      payload: payload === null ? null : { ...payload },
      payloadHash,
      safeEnvelope: null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return { recorded: true, id };
  }

  return {
    all: () => [...rows.values()].map(clone),
    get: (id) => {
      const row = rows.get(id);
      return row === undefined ? undefined : clone(row);
    },

    async recordIntent(input) {
      return record(input, "pending", null, null);
    },

    async propose(input, payload, payloadHash) {
      assertProposalChain(input, payload);
      return record(input, "proposed", payload, payloadHash);
    },

    async proposals(action?: string) {
      return [...rows.values()]
        .filter(
          (r) =>
            AWAITING_OPERATOR.includes(r.status) &&
            r.payloadHash !== null &&
            (action === undefined || r.action === action)
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },

    async getIntent(id: string) {
      const row = rows.get(id);
      return row === undefined ? null : clone(row);
    },

    async claimProposal(id, expectedPayloadHash, envelope) {
      const row = rows.get(id);
      if (!row) return { claimed: false, reason: "not-found", existing: null };
      if (row.status !== "proposed")
        return { claimed: false, reason: "not-proposed", existing: clone(row) };
      if (row.payloadHash !== expectedPayloadHash)
        return { claimed: false, reason: "hash-mismatch", existing: clone(row) };
      const updated: TxIntent = {
        ...row,
        status: "claimed",
        safeEnvelope: envelope ? { ...envelope } : null,
        updatedAt: now(),
      };
      rows.set(id, updated);
      return { claimed: true, intent: clone(updated) };
    },

    async markBroadcast(id, txHash, expectedPayloadHash) {
      const row = rows.get(id);
      // Same guards as the Postgres compare-and-set: a `claimed` row (the fence ran) still awaiting
      // broadcast, still the payload the operator verified. A released/superseded/reported row fails.
      if (!row || row.status !== "claimed" || row.txHash !== null) return false;
      if (row.payloadHash !== expectedPayloadHash) return false;
      rows.set(id, { ...row, status: "submitted", txHash, updatedAt: now() });
      return true;
    },

    async release(id, expectedPayloadHash) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed" || row.payloadHash !== expectedPayloadHash) return false;
      rows.set(id, { ...row, status: "proposed", safeEnvelope: null, updatedAt: now() });
      return true;
    },

    async fail(id, error) {
      const row = rows.get(id);
      if (!row) return false;
      if (!["proposed", "claimed", "pending", "submitted"].includes(row.status)) return false;
      rows.set(id, { ...row, status: "failed", error: error ?? row.error, updatedAt: now() });
      return true;
    },

    async supersede(id) {
      const row = rows.get(id);
      if (!row || row.status !== "proposed") return false;
      rows.set(id, { ...row, status: "superseded", updatedAt: now() });
      return true;
    },

    async expireProposals(ttlMs, action) {
      const cutoff = now() - ttlMs;
      let swept = 0;
      for (const [id, row] of rows) {
        if (row.status !== "proposed") continue;
        if (action !== undefined && row.action !== action) continue;
        if (row.updatedAt > cutoff) continue;
        rows.set(id, { ...row, status: "expired", updatedAt: now() });
        swept++;
      }
      return swept;
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
        updatedAt: now(),
      });
    },

    async reconcile(action?: string) {
      // IN_FLIGHT_ON_CHAIN only — `proposed` has no tx to reconcile and must not appear here.
      return [...rows.values()]
        .filter(
          (r) =>
            IN_FLIGHT_ON_CHAIN.includes(r.status) && (action === undefined || r.action === action)
        )
        .map(clone);
    },

    async close() {},
  };
}
