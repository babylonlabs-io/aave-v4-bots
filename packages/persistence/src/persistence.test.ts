import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type ChainReader,
  type IntentInput,
  type IntentStatus,
  type RecordResult,
  type StateStore,
  type TransitionMeta,
  type TxIntent,
  idempotencyKey,
  reconcilePending,
} from "./index";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
}

/**
 * An in-memory `StateStore` that faithfully mirrors the adapter's semantics (idempotency
 * refuse/revive, nonce lease, reconcile work-list). Used to drive the `reconcilePending`
 * logic without a database; the real SQL is covered by the gated integration test.
 */
function createMemoryStore(): StateStore & { all(): TxIntent[] } {
  const rows = new Map<string, TxIntent>();
  const leases = new Map<string, number>();
  const live: IntentStatus[] = ["pending", "submitted"];

  return {
    all: () => [...rows.values()],

    async reserveNonce(address) {
      const key = address.toLowerCase();
      const next = leases.get(key);
      if (next === undefined) throw new Error("not seeded");
      leases.set(key, next + 1);
      return next;
    },
    async syncNonce(address, chainNonce) {
      leases.set(address.toLowerCase(), chainNonce);
    },
    async recordIntent(i): Promise<RecordResult> {
      const id = idempotencyKey(i);
      const now = Date.now();
      const existing = rows.get(id);
      if (existing && live.includes(existing.status)) {
        return { recorded: false, existing };
      }
      rows.set(id, {
        id,
        ...i,
        status: "pending",
        nonce: null,
        txHash: null,
        error: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return { recorded: true, id };
    },
    async transition(id, to: IntentStatus, meta?: TransitionMeta) {
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
    async reconcile() {
      return [...rows.values()].filter((r) => live.includes(r.status));
    },
    async close() {},
  };
}

/** A `ChainReader` with scripted receipt statuses and fixed latest/pending nonces. */
function reader(over: {
  receipts?: Record<string, "success" | "reverted" | null>;
  latest?: number;
  pending?: number;
}): ChainReader {
  return {
    async getReceiptStatus(hash) {
      return over.receipts?.[hash] ?? null;
    },
    async getNonce(_address, tag) {
      return (tag === "latest" ? over.latest : over.pending) ?? 0;
    },
  };
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
    const store = createMemoryStore();
    expect((await store.recordIntent(input("p"))).recorded).toBe(true);

    const second = await store.recordIntent(input("p"));
    expect(second.recorded).toBe(false);

    await store.transition(idempotencyKey(input("p")), "confirmed");
    expect((await store.recordIntent(input("p"))).recorded).toBe(true); // revived
  });
});

describe("reconcilePending", () => {
  it("confirms a submitted intent whose receipt succeeded", async () => {
    const store = createMemoryStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": "success" }, latest: 5, pending: 6 }),
    });

    expect(summary).toMatchObject({ examined: 1, confirmed: 1, failed: 0, stillInFlight: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("confirmed");
  });

  it("fails a no-hash pending intent whose reserved nonce was already mined", async () => {
    const store = createMemoryStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 4 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 5, pending: 5 }), // nonce 4 already mined, no hash to check
    });

    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("fails a submitted intent whose tx was dropped (nonce mined past, no receipt)", async () => {
    const store = createMemoryStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 6, pending: 6 }),
    });

    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
  });

  it("leaves a genuinely-pending submitted intent in-flight", async () => {
    const store = createMemoryStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 6 }),
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0, confirmed: 0 });
  });

  it("fails a pending intent that was never broadcast (re-drivable)", async () => {
    const store = createMemoryStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 7 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 7, pending: 7 }), // nothing at nonce 7 yet
    });

    expect(summary).toMatchObject({ failed: 1 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("keeps a pending intent live when its reserved nonce is already in the mempool", async () => {
    const store = createMemoryStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 7 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 7, pending: 8 }), // a tx occupies nonce 7 in the mempool
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
    expect(store.all()[0].status).toBe("submitted");
  });

  it("no-ops with nothing in flight", async () => {
    const store = createMemoryStore();
    const summary = await reconcilePending({ store, signer: SIGNER, reader: reader({}) });
    expect(summary.examined).toBe(0);
  });
});
