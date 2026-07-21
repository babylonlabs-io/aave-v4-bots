import pg from "pg";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyKey } from "./index";
import { createPostgresStateStore } from "./postgres";

// Opt-in integration test that hits a **real Postgres** (the unit test in `persistence.test.ts`
// uses an in-memory model). It runs only when a connection string is configured; otherwise the
// whole block is skipped, so `pnpm test` stays offline by default.
//
// To run against the local dev database (`pnpm liquidator:db:up`):
//   export PERSISTENCE_E2E_DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
//   pnpm --filter @repo/persistence test postgres.integration
//
// Each run uses a unique schema and drops it afterwards, so it never touches the indexer's tables.

const DATABASE_URL = process.env.PERSISTENCE_E2E_DATABASE_URL;
const SCHEMA = `bot_e2e_${Date.now()}`;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const TIMEOUT = 30_000;

const input = (subject: string) => ({
  chainId: 31337,
  target: TARGET,
  action: "liquidation",
  subject,
});

describe.runIf(!!DATABASE_URL)("createPostgresStateStore (integration — real Postgres)", () => {
  const store = createPostgresStateStore({
    connectionString: DATABASE_URL as string,
    schema: SCHEMA,
  });

  afterAll(async () => {
    await store.close();
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it(
    "records a fresh intent, refuses a second live one, revives a terminal one",
    async () => {
      const fresh = await store.recordIntent(input("pos-1"));
      expect(fresh.recorded).toBe(true);

      const dup = await store.recordIntent(input("pos-1"));
      expect(dup.recorded).toBe(false);
      if (!dup.recorded) expect(dup.existing.status).toBe("pending");

      await store.transition(idempotencyKey(input("pos-1")), "confirmed", {
        txHash: "0xdead" as Hex,
      });
      const revived = await store.recordIntent(input("pos-1"));
      expect(revived.recorded).toBe(true); // terminal → new attempt allowed
    },
    TIMEOUT
  );

  it(
    "reconcile returns only in-flight intents",
    async () => {
      await store.recordIntent(input("inflight-a"));
      await store.recordIntent(input("inflight-b"));
      await store.transition(idempotencyKey(input("inflight-b")), "submitted", {
        nonce: 3,
        txHash: "0xbeef" as Hex,
      });
      await store.recordIntent(input("done"));
      await store.transition(idempotencyKey(input("done")), "confirmed");

      const inflight = await store.reconcile();
      const subjects = inflight.map((i) => i.subject);
      expect(subjects).toContain("inflight-a");
      expect(subjects).toContain("inflight-b");
      expect(subjects).not.toContain("done");

      const b = inflight.find((i) => i.subject === "inflight-b");
      expect(b?.status).toBe("submitted");
      expect(b?.nonce).toBe(3);
      expect(b?.txHash).toBe("0xbeef");
    },
    TIMEOUT
  );
});
