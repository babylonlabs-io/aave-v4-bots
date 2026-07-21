import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { type IntentInput, type ProposedTx, idempotencyKey } from "./index";
import { createMemoryStateStore } from "./memory";

// `reconcilePending` moved to `@repo/engine` (it orchestrates this store *and* chain queries);
// its tests live there, in `reconcile.test.ts`.

const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
}

describe("idempotencyKey", () => {
  it("is deterministic and independent of address casing", () => {
    const a = idempotencyKey(input("0xABCDEF0000000000000000000000000000000000"));
    const b = idempotencyKey(input("0xabcdef0000000000000000000000000000000000"));
    expect(a).toBe(b);
    expect(a).toBe(
      "31337:0x2222222222222222222222222222222222222222:liquidation:0xabcdef0000000000000000000000000000000000"
    );
  });

  it("distinguishes chain, target, action and subject", () => {
    const base = input("pos-1");
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-2")));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-1", { action: "arb" })));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey(input("pos-1", { chainId: 1 })));
  });
});

describe("recordIntent idempotency (memory model)", () => {
  it("refuses a second live record, revives a terminal one", async () => {
    const store = createMemoryStateStore();
    expect((await store.recordIntent(input("p"))).recorded).toBe(true);

    const second = await store.recordIntent(input("p"));
    expect(second.recorded).toBe(false);

    await store.transition(idempotencyKey(input("p")), "confirmed");
    expect((await store.recordIntent(input("p"))).recorded).toBe(true); // revived
  });

  it("revives from every terminal status, including the new proposal-lifecycle ones", async () => {
    for (const terminal of ["confirmed", "failed", "superseded", "expired"] as const) {
      const store = createMemoryStateStore();
      await store.recordIntent(input("p"));
      await store.transition(idempotencyKey(input("p")), terminal);
      expect((await store.recordIntent(input("p"))).recorded, terminal).toBe(true);
    }
  });
});

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

describe("MANUAL proposal lifecycle (memory model)", () => {
  it("propose persists the payload + hash as a `proposed` intent", async () => {
    const store = createMemoryStateStore();
    const p = payload();

    const result = await store.propose(input("p"), p, HASH_A);

    expect(result.recorded).toBe(true);
    const row = store.get(idempotencyKey(input("p")));
    expect(row).toMatchObject({ status: "proposed", payload: p, payloadHash: HASH_A, nonce: null });
  });

  it("dedups a proposal — a second propose for the same subject is refused", async () => {
    const store = createMemoryStateStore();
    await store.propose(input("p"), payload(), HASH_A);

    const second = await store.propose(input("p"), payload(), HASH_A);

    // Live-for-dedup: no notification storm. The refusal hands back the existing hash so the caller
    // can decide whether the payload changed.
    expect(second.recorded).toBe(false);
    if (!second.recorded) expect(second.existing.payloadHash).toBe(HASH_A);
  });

  it("a live proposal also blocks an AUTO recordIntent for the same subject", async () => {
    const store = createMemoryStateStore();
    await store.propose(input("p"), payload(), HASH_A);
    expect((await store.recordIntent(input("p"))).recorded).toBe(false);
  });

  it("a proposal never appears in the reconcile work-list (no tx to reconcile)", async () => {
    const store = createMemoryStateStore();
    await store.propose(input("p"), payload(), HASH_A);
    expect(await store.reconcile()).toEqual([]);
  });

  describe("markBroadcast", () => {
    it("moves proposed → submitted and records the hash", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(true);
      expect(store.get(id)).toMatchObject({ status: "submitted", txHash: TX });
      // Now it IS on the reconcile work-list — the bot picks up a tx it never sent.
      expect((await store.reconcile()).map((r) => r.id)).toContain(id);
    });

    it("rejects a hash that does not match the proposal the operator verified", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      expect(await store.markBroadcast(id, TX, HASH_B)).toBe(false);
      expect(store.get(id)).toMatchObject({ status: "proposed", txHash: null });
    });

    it("rejects once the proposal was superseded (payload changed under the operator)", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.supersede(id);
      // The operator tries to broadcast the hash they saw; it is no longer live.
      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(false);
    });

    it("is not idempotent — a second report is refused (no hash overwrite)", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.markBroadcast(id, TX, HASH_A);
      expect(await store.markBroadcast(id, HASH_B, HASH_A)).toBe(false);
      expect(store.get(id)?.txHash).toBe(TX);
    });
  });

  describe("supersede", () => {
    it("retires a proposed intent and frees the subject for a fresh proposal", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload({ value: "1" }), HASH_A);

      expect(await store.supersede(id)).toBe(true);
      expect(store.get(id)?.status).toBe("superseded");

      // Re-propose with the changed payload — the same row revives.
      const re = await store.propose(input("p"), payload({ value: "2" }), HASH_B);
      expect(re.recorded).toBe(true);
      expect(store.get(id)).toMatchObject({ status: "proposed", payloadHash: HASH_B });
    });

    it("will not supersede a submitted (real, on-chain) intent", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.recordIntent(input("p"));
      await store.transition(id, "submitted", { txHash: TX });
      expect(await store.supersede(id)).toBe(false);
      expect(store.get(id)?.status).toBe("submitted");
    });
  });

  describe("expireProposals", () => {
    // A store whose clock the test drives, so a proposal is aged by advancing time — not by reaching
    // through a returned row (which is a copy, exactly as Postgres would hand back).
    const clockedStore = () => {
      let t = 1_000_000;
      const store = createMemoryStateStore(() => t);
      return {
        store,
        advance: (ms: number) => {
          t += ms;
        },
      };
    };

    it("sweeps only proposals past the TTL, and reports how many", async () => {
      const { store, advance } = clockedStore();
      await store.propose(input("old"), payload(), HASH_A);
      advance(45_000); // "old" recorded 45s ago...
      await store.propose(input("fresh"), payload(), HASH_B); // ...then "fresh" now

      const swept = await store.expireProposals(30_000);

      expect(swept).toBe(1);
      expect(store.get(idempotencyKey(input("old")))?.status).toBe("expired");
      expect(store.get(idempotencyKey(input("fresh")))?.status).toBe("proposed");
    });

    it("scopes the sweep to one action when asked", async () => {
      const { store, advance } = clockedStore();
      await store.propose(input("a", { action: "liquidation" }), payload(), HASH_A);
      await store.propose(input("b", { action: "vault-acquisition" }), payload(), HASH_B);
      advance(60_000); // both now past a 30s TTL

      const swept = await store.expireProposals(30_000, "liquidation");

      expect(swept).toBe(1);
      expect(store.get(idempotencyKey(input("a", { action: "liquidation" })))?.status).toBe(
        "expired"
      );
      expect(store.get(idempotencyKey(input("b", { action: "vault-acquisition" })))?.status).toBe(
        "proposed"
      );
    });

    it("treats the TTL boundary as at-or-older (updatedAt <= now - ttl is swept)", async () => {
      const { store, advance } = clockedStore();
      await store.propose(input("at"), payload(), HASH_A);
      advance(30_000); // updatedAt is now exactly `now - ttl`

      // A shorter window (updatedAt strictly younger than the cutoff) keeps it...
      expect(await store.expireProposals(30_001)).toBe(0);
      expect(store.get(idempotencyKey(input("at")))?.status).toBe("proposed");

      // ...and exactly at the boundary (cutoff == updatedAt) it is swept.
      expect(await store.expireProposals(30_000)).toBe(1);
      expect(store.get(idempotencyKey(input("at")))?.status).toBe("expired");
    });

    it("an expired proposal is revivable — the subject can be proposed again", async () => {
      const { store, advance } = clockedStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      advance(60_000);
      await store.expireProposals(30_000);

      expect((await store.propose(input("p"), payload(), HASH_B)).recorded).toBe(true);
      expect(store.get(id)?.status).toBe("proposed");
    });
  });

  it("returns copies — mutating a read row cannot corrupt stored state (Postgres parity)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.propose(input("p"), payload({ value: "5" }), HASH_A);

    const read = store.get(id);
    if (read) {
      read.status = "confirmed"; // reach through a returned row...
      if (read.payload) read.payload.value = "999";
    }

    // ...the store is untouched.
    expect(store.get(id)).toMatchObject({ status: "proposed", payload: { value: "5" } });
  });
});
