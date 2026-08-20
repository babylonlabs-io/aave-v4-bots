import type { ProposedTx } from "@repo/execution";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { type IntentInput, type SafeEnvelope, idempotencyKey } from "./index";
import { createMemoryStateStore } from "./memory";
import { DEFAULT_POOL_TIMEOUTS } from "./postgres";

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

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SAFE_ENV: SafeEnvelope = {
  safeNonce: 7,
  operation: 0,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: ZERO,
  refundReceiver: ZERO,
  safeVersion: "1.4.1",
  safeTxHash: `0x${"e".repeat(64)}` as Hex,
  claimBlock: 1000,
};

describe("MANUAL proposal lifecycle (memory model)", () => {
  it("propose persists the payload + hash as a `proposed` intent", async () => {
    const store = createMemoryStateStore();
    const p = payload();

    const result = await store.propose(input("p"), p, HASH_A);

    expect(result.recorded).toBe(true);
    const row = store.get(idempotencyKey(input("p")));
    expect(row).toMatchObject({ status: "proposed", payload: p, payloadHash: HASH_A, nonce: null });
  });

  // Rejected rather than stored, because the two chain ids drive different consumers: the row's keys
  // dedup and reconcile, the payload's is what the operator signs and broadcasts against. A row that
  // disagreed with itself would have the operator acting on a chain the bot never looks at.
  it("refuses a payload that targets a different chain than the intent", async () => {
    const store = createMemoryStateStore();

    await expect(store.propose(input("p"), payload({ chainId: 1 }), HASH_A)).rejects.toThrow(
      /chain 31337 but its payload targets 1/
    );
    expect(store.all()).toHaveLength(0);
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

  describe("claimProposal (the fence)", () => {
    it("moves proposed → claimed on a matching hash", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      const res = await store.claimProposal(id, HASH_A);
      expect(res.claimed).toBe(true);
      expect(store.get(id)?.status).toBe("claimed");
    });

    it("refuses a hash mismatch, leaving the proposal claimable", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      expect(await store.claimProposal(id, HASH_B)).toMatchObject({
        claimed: false,
        reason: "hash-mismatch",
      });
      expect(store.get(id)?.status).toBe("proposed");
    });

    it("refuses a superseded proposal — the stale-broadcast race, closed before signing", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.supersede(id);
      expect(await store.claimProposal(id, HASH_A)).toMatchObject({
        claimed: false,
        reason: "not-proposed",
      });
    });

    it("refuses a second claim — the proposal is already spoken-for", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.claimProposal(id, HASH_A);
      expect(await store.claimProposal(id, HASH_A)).toMatchObject({
        claimed: false,
        reason: "not-proposed",
      });
    });

    it("reports not-found for an unknown id", async () => {
      const store = createMemoryStateStore();
      expect(await store.claimProposal("nope", HASH_A)).toEqual({
        claimed: false,
        reason: "not-found",
        existing: null,
      });
    });

    it("persists the Safe envelope for `safe` custody", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      const res = await store.claimProposal(id, HASH_A, SAFE_ENV);
      expect(res.claimed && res.intent.safeEnvelope).toMatchObject({
        safeTxHash: SAFE_ENV.safeTxHash,
        safeNonce: 7,
      });
      expect(store.get(id)?.safeEnvelope?.safeNonce).toBe(7);
    });

    it("a claimed proposal dedups a re-propose, stays off reconcile, and survives the expiry sweep", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.claimProposal(id, HASH_A);

      expect((await store.propose(input("p"), payload(), HASH_A)).recorded).toBe(false);
      expect(await store.reconcile()).toEqual([]); // no tx yet — not on-chain
      expect(await store.expireProposals(0)).toBe(0); // sweep only touches `proposed`
      expect(store.get(id)?.status).toBe("claimed");
    });
  });

  describe("markBroadcast (claimed → submitted)", () => {
    const claim = async (store: ReturnType<typeof createMemoryStateStore>, id: string) => {
      await store.propose(input("p"), payload(), HASH_A);
      await store.claimProposal(id, HASH_A);
    };

    it("moves claimed → submitted and records the hash", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await claim(store, id);

      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(true);
      expect(store.get(id)).toMatchObject({ status: "submitted", txHash: TX });
      // Now it IS on the reconcile work-list — the bot picks up a tx it never sent.
      expect((await store.reconcile()).map((r) => r.id)).toContain(id);
    });

    it("refuses an unclaimed proposal — broadcast requires the fence", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);

      expect(await store.markBroadcast(id, TX, HASH_A)).toBe(false);
      expect(store.get(id)).toMatchObject({ status: "proposed", txHash: null });
    });

    it("rejects a hash that no longer matches the claimed payload", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await claim(store, id);
      expect(await store.markBroadcast(id, TX, HASH_B)).toBe(false);
    });

    it("is not idempotent — a second report is refused (no hash overwrite)", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await claim(store, id);
      await store.markBroadcast(id, TX, HASH_A);
      expect(await store.markBroadcast(id, HASH_B, HASH_A)).toBe(false);
      expect(store.get(id)?.txHash).toBe(TX);
    });
  });

  describe("release + fail (recovery)", () => {
    it("release reverts claimed → proposed and clears the envelope", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.claimProposal(id, HASH_A, SAFE_ENV);

      expect(await store.release(id, HASH_A)).toBe(true);
      expect(store.get(id)).toMatchObject({ status: "proposed", safeEnvelope: null });
    });

    it("release refuses a non-claimed row or a hash mismatch", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      expect(await store.release(id, HASH_A)).toBe(false); // still `proposed`, not claimed
      await store.claimProposal(id, HASH_A);
      expect(await store.release(id, HASH_B)).toBe(false); // wrong hash
      expect(store.get(id)?.status).toBe("claimed");
    });

    it("fail marks a live intent failed and revives the subject", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.propose(input("p"), payload(), HASH_A);
      await store.claimProposal(id, HASH_A);

      expect(await store.fail(id, "dropped")).toBe(true);
      expect(store.get(id)).toMatchObject({ status: "failed", error: "dropped" });
      expect((await store.propose(input("p"), payload(), HASH_B)).recorded).toBe(true);
    });

    it("fail refuses a terminal intent", async () => {
      const store = createMemoryStateStore();
      const id = idempotencyKey(input("p"));
      await store.recordIntent(input("p"));
      await store.transition(id, "confirmed");
      expect(await store.fail(id)).toBe(false);
    });
  });

  describe("proposals (operator work-list)", () => {
    it("returns proposed + claimed rows, oldest first, and scopes by action", async () => {
      const store = createMemoryStateStore();
      await store.propose(input("a", { action: "liquidation" }), payload(), HASH_A);
      await store.propose(input("b", { action: "vault-acquisition" }), payload(), HASH_B);
      const idA = idempotencyKey(input("a", { action: "liquidation" }));
      await store.claimProposal(idA, HASH_A);

      const all = await store.proposals();
      expect(all.map((r) => r.subject)).toEqual(["a", "b"]);
      expect(all.find((r) => r.subject === "a")?.status).toBe("claimed");

      expect((await store.proposals("liquidation")).map((r) => r.subject)).toEqual(["a"]);
    });

    it("excludes AUTO `pending` (no payload) and terminal rows", async () => {
      const store = createMemoryStateStore();
      await store.recordIntent(input("auto")); // AUTO `pending`, no payload
      await store.propose(input("man"), payload(), HASH_A);

      expect((await store.proposals()).map((r) => r.subject)).toEqual(["man"]);
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

// Everything in a schema is scoped to one account by assumption, never by column: the idempotency
// key carries no signer, `reconcile()` returns every in-flight intent, and the nonce fence reads
// them as one sequence. Two bots sharing a schema therefore resolve each other's transactions
// against the wrong nonces — and collide outright on approvals, where the same token and spender
// give two signers the same key. `PERSISTENCE_SCHEMA` defaults to `bot` for both services, so that
// is one shared DATABASE_URL away. This makes it a boot failure instead.
describe("bindExecutionIdentity", () => {
  const A = { chainId: 1, address: "0xAaAa000000000000000000000000000000000001" as const };
  const B = { chainId: 1, address: "0xbBbB000000000000000000000000000000000002" as const };

  it("claims an unowned store", async () => {
    const store = createMemoryStateStore();
    await expect(store.bindExecutionIdentity(A)).resolves.toBeUndefined();
  });

  it("is idempotent for the owner, and case-insensitive about its address", async () => {
    const store = createMemoryStateStore();
    await store.bindExecutionIdentity(A);
    await expect(store.bindExecutionIdentity(A)).resolves.toBeUndefined();
    await expect(
      store.bindExecutionIdentity({ ...A, address: A.address.toLowerCase() as typeof A.address })
    ).resolves.toBeUndefined();
  });

  it("refuses a second signer", async () => {
    const store = createMemoryStateStore();
    await store.bindExecutionIdentity(A);
    await expect(store.bindExecutionIdentity(B)).rejects.toThrow(
      /one store belongs to one account/
    );
  });

  // Same address, different chain is still a different execution identity: nonces are per chain.
  it("refuses the same address on another chain", async () => {
    const store = createMemoryStateStore();
    await store.bindExecutionIdentity(A);
    await expect(store.bindExecutionIdentity({ ...A, chainId: 8453 })).rejects.toThrow(/bound to/);
  });
});

// Intent ids are reused: a terminal row is revived by the next `recordIntent` for the same subject.
// So a writer that finished with attempt 1 — a receipt arriving after reconcile already resolved it
// — can find attempt 2 sitting under the same id. Without a guard it stamps the old verdict on the
// new transaction. The rule: chain evidence may correct our reading of the transaction it is about,
// and must never touch a different one.
describe("transition — bound to the row the caller observed", () => {
  const input: IntentInput = {
    chainId: 1,
    target: "0x2222222222222222222222222222222222222222",
    action: "liquidation",
    subject: "pos-1",
  };

  const seed = async () => {
    const store = createMemoryStateStore();
    const { id } = (await store.recordIntent(input)) as { id: string };
    await store.transition(id, "submitted", { nonce: 1, txHash: "0xaaa" });
    return { store, id };
  };

  it("applies when the row still carries the observed hash", async () => {
    const { store, id } = await seed();
    await expect(store.transition(id, "confirmed", {}, { txHash: "0xaaa" })).resolves.toBe(true);
    expect(store.get(id)?.status).toBe("confirmed");
  });

  it("refuses to stamp a later attempt that reused the id", async () => {
    const { store, id } = await seed();
    // Attempt 1 ends; the subject is revived and attempt 2 broadcasts a different transaction.
    await store.transition(id, "failed", { error: "not accepted" });
    await store.recordIntent(input);
    await store.transition(id, "submitted", { nonce: 2, txHash: "0xbbb" });

    // A receipt for attempt 1 arrives late.
    await expect(store.transition(id, "confirmed", {}, { txHash: "0xaaa" })).resolves.toBe(false);
    expect(store.get(id)).toMatchObject({ status: "submitted", txHash: "0xbbb" });
  });

  it("refuses when the row has moved on from the status the caller saw", async () => {
    const { store, id } = await seed();
    await store.transition(id, "confirmed", {});

    await expect(
      store.transition(id, "failed", { error: "stale" }, { status: ["submitted"] })
    ).resolves.toBe(false);
    expect(store.get(id)?.status).toBe("confirmed");
  });
});

// A store write runs inside the nonce allocator's lock — `markPending` is awaited there — so a
// query that never returns holds the lock and stops both engines. `pg` waits forever by default.
describe("the default pool's deadlines", () => {
  it("bounds every way a query can fail to return", () => {
    for (const [name, ms] of Object.entries(DEFAULT_POOL_TIMEOUTS)) {
      expect(ms, name).toBeGreaterThan(0);
    }
  });

  // The client-side budget must outlast the server-side one. Inverted, `pg` gives up first and the
  // server-side timeout — the half that bounds lock waits and cleans up abandoned work — never
  // applies to anything.
  it("lets the server-side budget expire before the client stops waiting", () => {
    expect(DEFAULT_POOL_TIMEOUTS.query_timeout).toBeGreaterThan(
      DEFAULT_POOL_TIMEOUTS.statement_timeout
    );
  });
});
