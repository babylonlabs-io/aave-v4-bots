import type { ProposedTx } from "@repo/execution";
import pg from "pg";
import type { Address, Hex } from "viem";
import { afterAll, describe, expect, it } from "vitest";
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

const input = (subject: string, over: { action?: string } = {}) => ({
  chainId: 31337,
  target: TARGET,
  action: "liquidation",
  subject,
  ...over,
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

  // The horizon is a BIGINT read back through `Number`, and it is what releases a privately-sent
  // nonce — a column that silently returned a string, or that a later transition wiped, would leave
  // the fence comparing a chain head against nothing.
  it(
    "round-trips the relay horizon as a number and keeps it across later transitions",
    async () => {
      const id = idempotencyKey(input("horizon-1"));
      await store.recordIntent(input("horizon-1"));
      await store.transition(id, "submitted", {
        nonce: 4,
        txHash: "0xfeed" as Hex,
        relayMaxBlock: 23_456_789,
      });

      const submitted = (await store.reconcile()).find((i) => i.subject === "horizon-1");
      expect(submitted?.relayMaxBlock).toBe(23_456_789);

      // A transition that states no horizon must not erase the one already recorded.
      await store.transition(id, "submitted", { error: "receipt timeout" });
      const after = (await store.reconcile()).find((i) => i.subject === "horizon-1");
      expect(after?.relayMaxBlock).toBe(23_456_789);

      // A revived row is a new attempt with a new transaction: its predecessor's deadline must go.
      await store.transition(id, "failed", {});
      await store.recordIntent(input("horizon-1"));
      const revived = (await store.reconcile()).find((i) => i.subject === "horizon-1");
      expect(revived?.relayMaxBlock).toBeNull();
    },
    TIMEOUT
  );

  const HASH_A = `0x${"a".repeat(64)}` as Hex;
  const HASH_B = `0x${"b".repeat(64)}` as Hex;
  const TX = `0x${"c".repeat(64)}` as Hex;
  const payload = (over: Partial<ProposedTx> = {}): ProposedTx => ({
    chainId: 31337,
    to: TARGET,
    data: "0xdeadbeef",
    value: "0",
    ...over,
  });

  it(
    "propose round-trips the jsonb payload and keeps it out of the reconcile work-list",
    async () => {
      const p = payload({ gasLimit: "500000" });
      const result = await store.propose(input("prop-1"), p, HASH_A);
      expect(result.recorded).toBe(true);

      // The proposal is live for dedup but absent from reconcile.
      expect((await store.recordIntent(input("prop-1"))).recorded).toBe(false);
      expect((await store.reconcile()).map((i) => i.subject)).not.toContain("prop-1");

      // jsonb survives the round trip intact (a second propose is refused and returns the row).
      const dup = await store.propose(input("prop-1"), p, HASH_A);
      expect(dup.recorded).toBe(false);
      if (!dup.recorded) {
        expect(dup.existing.payload).toEqual(p);
        expect(dup.existing.payloadHash).toBe(HASH_A);
      }
    },
    TIMEOUT
  );

  it(
    "markBroadcast is a guarded compare-and-set against a claimed proposal + verified hash",
    async () => {
      const id = idempotencyKey(input("prop-2"));
      await store.propose(input("prop-2"), payload(), HASH_A);

      // A still-`proposed` (unclaimed) row is refused — markBroadcast only advances a claimed proposal.
      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(false);

      // Claim it (proposed → claimed): the fence that must run before broadcast.
      expect((await store.claimProposal(id, HASH_A)).claimed).toBe(true);

      // Wrong hash → refused, untouched.
      expect(await store.markBroadcast(id, TX, HASH_B)).toBe(false);
      // Right hash → claimed becomes a hash-bearing in-flight intent.
      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(true);

      const inflight = await store.reconcile();
      const row = inflight.find((i) => i.subject === "prop-2");
      expect(row).toMatchObject({ status: "submitted", txHash: TX, nonce: null });

      // Not idempotent — a second report cannot overwrite the recorded hash.
      expect(await store.markBroadcast(id, HASH_B, HASH_A)).toBe(false);
    },
    TIMEOUT
  );

  it(
    "supersede retires a proposal and refuses a submitted one",
    async () => {
      const supId = idempotencyKey(input("prop-sup"));
      await store.propose(input("prop-sup"), payload({ value: "1" }), HASH_A);
      expect(await store.supersede(supId)).toBe(true);
      // Re-proposable after supersede.
      expect(
        (await store.propose(input("prop-sup"), payload({ value: "2" }), HASH_B)).recorded
      ).toBe(true);

      // A submitted (real, on-chain) intent is never superseded.
      const liveId = idempotencyKey(input("prop-live"));
      await store.recordIntent(input("prop-live"));
      await store.transition(liveId, "submitted", { txHash: TX });
      expect(await store.supersede(liveId)).toBe(false);
    },
    TIMEOUT
  );

  it(
    "expireProposals sweeps exactly the past-TTL proposals in its action scope",
    async () => {
      // A dedicated action so the count is exact — the shared schema carries `liquidation`
      // proposals from earlier tests, and this assertion must not depend on how many.
      const EXP = { action: "expiry-test" };
      await store.propose(input("exp-a", EXP), payload(), HASH_A);
      await store.propose(input("exp-b", EXP), payload(), HASH_B);

      // A 0ms window means "updatedAt <= now"; both were proposed in the past, so both go — and
      // nothing outside this action is touched.
      expect(await store.expireProposals(0, "expiry-test")).toBe(2);

      expect((await store.reconcile()).map((i) => i.subject)).not.toContain("exp-a"); // not in-flight
      expect((await store.propose(input("exp-a", EXP), payload(), HASH_A)).recorded).toBe(true); // revivable
    },
    TIMEOUT
  );

  // SQL the memory adapter cannot stand in for: a real `ON CONFLICT DO NOTHING` claim, and a real
  // `status = ANY($8)` guard. Both are new, and both are the kind of thing that type-checks while
  // being wrong.
  it(
    "binds the schema to one execution identity and refuses another",
    async () => {
      const identity = {
        chainId: 31337,
        address: "0xAaAa000000000000000000000000000000000001" as Hex,
      };
      await store.bindExecutionIdentity(identity);
      // Idempotent for the owner, including a differently-cased address.
      await store.bindExecutionIdentity({
        ...identity,
        address: identity.address.toLowerCase() as Hex,
      });

      await expect(
        store.bindExecutionIdentity({
          chainId: 31337,
          address: "0xbBbB000000000000000000000000000000000002",
        })
      ).rejects.toThrow(/is bound to/);
      // Same address, other chain — a different nonce sequence, so a different identity.
      await expect(store.bindExecutionIdentity({ ...identity, chainId: 8453 })).rejects.toThrow(
        /is bound to/
      );
    },
    TIMEOUT
  );

  it(
    "applies a guarded transition only to the row the caller observed",
    async () => {
      const key = idempotencyKey(input("pos-guard"));
      await store.recordIntent(input("pos-guard"));
      await store.transition(key, "submitted", { nonce: 9, txHash: "0xaaa" as Hex });

      // Wrong hash: a late writer from a previous attempt must not land.
      expect(await store.transition(key, "confirmed", {}, { txHash: "0xbbb" as Hex })).toBe(false);
      expect((await store.getIntent(key))?.status).toBe("submitted");

      // Wrong status: the row moved on since the caller read it.
      expect(await store.transition(key, "failed", {}, { status: ["pending"] })).toBe(false);
      expect((await store.getIntent(key))?.status).toBe("submitted");

      // Both match — it applies.
      expect(
        await store.transition(
          key,
          "confirmed",
          {},
          { txHash: "0xaaa" as Hex, status: ["submitted"] }
        )
      ).toBe(true);
      expect((await store.getIntent(key))?.status).toBe("confirmed");
    },
    TIMEOUT
  );
});
