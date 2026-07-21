import type { Logger } from "@repo/logger";
import { type StateStore, createPostgresStateStore, idempotencyKey } from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import pg from "pg";
import type { Address, Hex, PublicClient } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCrashSafety } from "./crashSafety";
import { type ChainReader, reconcilePending } from "./reconcile";

// Crash-safety against a **real Postgres**, the store production actually runs on. The unit tests
// use the in-memory model, which cannot catch a schema, transaction, or upsert bug — and
// no-double-submit is exactly the property those bugs would break.
//
// Runs only when a connection string is configured; otherwise the block skips, so `pnpm test`
// stays offline by default. CI supplies it (see .github/workflows/ci.yml).
//
//   pnpm liquidator:db:up
//   export PERSISTENCE_E2E_DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
//   pnpm --filter @repo/engine test crashSafety.integration

const DATABASE_URL = process.env.PERSISTENCE_E2E_DATABASE_URL;
const SCHEMA = `bot_e2e_engine_${Date.now()}`;
const TIMEOUT = 20_000;

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const TX = "0xhash" as Hex;

const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const intent = (subject: string) => ({
  chainId: 31337,
  target: TARGET,
  action: "liquidation",
  subject,
});

/** A slot that records what it was settled with, standing in for the risk gate's. */
function fakeSlot(): RiskSlot & { settled: unknown[] } {
  const settled: unknown[] = [];
  return { allowed: true, reason: "", settle: (o) => settled.push(o), settled };
}

/**
 * A `ChainReader` with scripted receipts and nonce counts. `known` defaults to `true` — a
 * recorded hash the node still knows about, i.e. a tx that really was broadcast.
 */
const reader = (over: {
  receipts?: Record<string, "success" | "reverted" | null>;
  latest?: number;
  pending?: number;
  known?: boolean;
}): ChainReader => ({
  async getReceiptStatus(hash) {
    return over.receipts?.[hash] ?? null;
  },
  async getNonce(_address, tag) {
    return (tag === "latest" ? over.latest : over.pending) ?? 0;
  },
  async isKnown() {
    return over.known ?? true;
  },
});

const publicClient = { getTransactionCount: vi.fn(async () => 0) } as unknown as PublicClient;

const crashSafety = (store: StateStore) =>
  createCrashSafety({ store, publicClient, signer: SIGNER, logger: silentLogger });

describe.skipIf(!DATABASE_URL)("crash-safety over a real Postgres StateStore", () => {
  let store: StateStore;

  beforeAll(async () => {
    store = createPostgresStateStore({ connectionString: DATABASE_URL as string, schema: SCHEMA });
    // Force the lazy DDL so `beforeEach` can truncate.
    await store.reconcile();
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  }, TIMEOUT);

  beforeEach(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`TRUNCATE ${SCHEMA}.tx_intents`);
    await admin.end();
  }, TIMEOUT);

  // The headline guarantee. A second process (or a re-drive after a crash) must not re-broadcast
  // an action whose intent is still live on chain.
  it(
    "refuses a duplicate live intent across two CrashSafety instances",
    async () => {
      const first = await crashSafety(store).claim(fakeSlot(), intent("pos-1"));
      expect(first).toEqual({ claimed: true, intentId: idempotencyKey(intent("pos-1")) });

      // A fresh process over the same durable store — the restart case.
      const slot = fakeSlot();
      const second = await crashSafety(store).claim(slot, intent("pos-1"));

      expect(second).toEqual({ claimed: false });
      expect(slot.settled).toEqual([{ ok: false, abandoned: true }]); // exposure released
    },
    TIMEOUT
  );

  it(
    "allows a re-drive once the intent reaches a terminal state",
    async () => {
      const cs = crashSafety(store);
      const { intentId } = await cs.claim(fakeSlot(), intent("pos-1"));
      if (!intentId) throw new Error("expected an intent id");

      await cs.transition(intentId, "failed", { error: "reverted" });

      expect(await cs.claim(fakeSlot(), intent("pos-1"))).toMatchObject({ claimed: true });
    },
    TIMEOUT
  );

  // markPending is the durability barrier: if the nonce cannot be persisted we must not broadcast.
  it(
    "markPending durably records the reserved nonce before broadcast",
    async () => {
      const cs = crashSafety(store);
      const { intentId } = await cs.claim(fakeSlot(), intent("pos-1"));
      if (!intentId) throw new Error("expected an intent id");

      await cs.markPending(intentId, 7);

      const [live] = await store.reconcile("liquidation");
      expect(live).toMatchObject({ subject: "pos-1", nonce: 7, status: "pending" });
    },
    TIMEOUT
  );

  describe("reconcilePending resolves a crashed run against the chain", () => {
    it(
      "confirms an intent whose tx mined successfully",
      async () => {
        const cs = crashSafety(store);
        const { intentId } = await cs.claim(fakeSlot(), intent("pos-1"));
        if (!intentId) throw new Error("expected an intent id");
        await cs.markPending(intentId, 5);
        await cs.transition(intentId, "submitted", { txHash: TX });
        // …process dies here…

        const summary = await reconcilePending({
          store,
          signer: SIGNER,
          reader: reader({ receipts: { [TX]: "success" }, latest: 5, pending: 6 }),
        });

        expect(summary).toMatchObject({ examined: 1, confirmed: 1, failed: 0 });
        expect(await store.reconcile()).toHaveLength(0); // nothing left in flight
      },
      TIMEOUT
    );

    // The dangerous direction: an intent that was never broadcast must become re-drivable, and one
    // still in the mempool must NOT — re-driving it would double-submit.
    it(
      "frees a never-broadcast intent but holds one still in the mempool",
      async () => {
        const cs = crashSafety(store);
        const a = await cs.claim(fakeSlot(), intent("never-sent"));
        const b = await cs.claim(fakeSlot(), intent("in-mempool"));
        if (!a.intentId || !b.intentId) throw new Error("expected intent ids");
        await cs.markPending(a.intentId, 9); // reserved nonce 9, chain never saw it
        await cs.markPending(b.intentId, 7); // reserved nonce 7, sitting in the mempool

        const summary = await reconcilePending({
          store,
          signer: SIGNER,
          reader: reader({ latest: 7, pending: 8 }), // nonce 7 pending; 9 untouched
        });

        expect(summary).toMatchObject({ examined: 2, failed: 1, stillInFlight: 1 });

        // never-sent is terminal ⇒ re-drivable; in-mempool is still live ⇒ refused.
        expect(await cs.claim(fakeSlot(), intent("never-sent"))).toMatchObject({ claimed: true });
        expect(await cs.claim(fakeSlot(), intent("in-mempool"))).toEqual({ claimed: false });
      },
      TIMEOUT
    );

    it(
      "leaves everything untouched when the chain is unreachable (fail closed)",
      async () => {
        const cs = crashSafety(store);
        const { intentId } = await cs.claim(fakeSlot(), intent("pos-1"));
        if (!intentId) throw new Error("expected an intent id");
        await cs.markPending(intentId, 5);
        await cs.transition(intentId, "submitted", { txHash: TX });

        const outage: ChainReader = {
          getReceiptStatus: async () => {
            throw new Error("ECONNREFUSED");
          },
          getNonce: async () => 9, // chain has moved past nonce 5
          isKnown: async () => {
            throw new Error("ECONNREFUSED");
          },
        };

        await expect(reconcilePending({ store, signer: SIGNER, reader: outage })).rejects.toThrow(
          "ECONNREFUSED"
        );

        // Still 'submitted' — NOT marked failed, so the next cycle cannot re-drive a mined tx.
        const [live] = await store.reconcile();
        expect(live).toMatchObject({ subject: "pos-1", status: "submitted" });
      },
      TIMEOUT
    );
  });
});
