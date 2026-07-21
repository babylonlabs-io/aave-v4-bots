import { type IntentInput, createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  type ChainReader,
  UNKNOWN_TX_GRACE_MS,
  createChainReader,
  reconcilePending,
} from "./reconcile";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
}

/**
 * A clock reading `ms` into the future, so an intent the store just recorded is judged as though it
 * were `ms` old — which is what decides whether an "unknown to the node" answer is trustworthy.
 */
const aged = (ms: number) => () => Date.now() + ms;

/**
 * A `ChainReader` with scripted receipt statuses and fixed latest/pending nonces. `known`
 * defaults to `true`: a recorded hash the node still knows about (i.e. in flight), which is
 * the case for every tx that was actually broadcast.
 */
function reader(over: {
  receipts?: Record<string, "success" | "reverted" | null>;
  latest?: number;
  pending?: number;
  known?: boolean;
}): ChainReader {
  return {
    async getReceiptStatus(hash) {
      return over.receipts?.[hash] ?? null;
    },
    async getNonce(_address, tag) {
      return (tag === "latest" ? over.latest : over.pending) ?? 0;
    },
    async isKnown() {
      return over.known ?? true;
    },
  };
}

describe("reconcilePending", () => {
  it("confirms a submitted intent whose receipt succeeded", async () => {
    const store = createMemoryStateStore();
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

  it("fails a submitted intent whose receipt reverted", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": "reverted" }, latest: 6, pending: 6 }),
    });

    expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("fails a no-hash pending intent whose reserved nonce was already mined", async () => {
    const store = createMemoryStateStore();
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
    const store = createMemoryStateStore();
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
    const store = createMemoryStateStore();
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
    const store = createMemoryStateStore();
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
    const store = createMemoryStateStore();
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

  it("fails a signed intent the node rejected (unknown hash, nonce slot still free)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    // Signed and recorded pre-broadcast, then the node refused it (e.g. insufficient funds).
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      // Nonce 5 never made it to the mempool, and the node has never seen the hash.
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: false }),
      now: aged(UNKNOWN_TX_GRACE_MS + 1), // past the grace window, so the "no" is trustworthy
    });

    // Nothing is on chain — re-drivable. Left in-flight it would be pinned forever: the same
    // rejection blocks every later send, so no tx would ever mine past nonce 5 to release it.
    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("failed");
  });

  // Behind a load-balanced RPC pool the node we ask need not be the node we broadcast to, so a tx
  // that IS on the wire can read as unknown until it propagates. Acting on that immediately is what
  // turns a routing artifact into a double-submitted liquidation.
  it("does NOT fail a just-signed intent the node has not seen yet (grace window)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: false }),
      now: aged(1_000), // recorded a second ago — far too young for "unknown" to mean rejected
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("submitted"); // not re-drivable yet
  });

  it("keeps a signed intent live while the node still knows its tx", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      // Broadcast landed; this node's `pending` count just hasn't caught up (some providers
      // never reflect the mempool). The tx is known, so it must NOT be treated as rejected.
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: true }),
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
  });

  it("no-ops with nothing in flight", async () => {
    const store = createMemoryStateStore();
    const summary = await reconcilePending({ store, signer: SIGNER, reader: reader({}) });
    expect(summary.examined).toBe(0);
  });

  // A keyless MANUAL bot has no signer nonce to read: its in-flight intents were broadcast by the
  // operator, so every one has `nonce === null`. Reconcile must resolve them by receipt alone and
  // issue no `getTransactionCount` — otherwise a keyless process makes a call it has no basis for.
  it("issues NO nonce reads when every in-flight intent is nonce-less (keyless path)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    // An operator-broadcast intent: a hash, but no nonce (see StateStore.markBroadcast).
    await store.transition(id, "submitted", { txHash: "0xhash" as Hex });

    const getNonce = vi.fn(async () => 0);
    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: { ...reader({ receipts: { "0xhash": "success" } }), getNonce },
    });

    expect(getNonce).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ confirmed: 1 }); // still resolved, by receipt
  });

  it("does read the signer nonce when some in-flight intent carries one (AUTO path)", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const getNonce = vi.fn(async (_a: Address, tag: "latest" | "pending") =>
      tag === "latest" ? 5 : 6
    );
    await reconcilePending({
      store,
      signer: SIGNER,
      reader: { ...reader({ receipts: { "0xhash": null } }), getNonce },
    });

    expect(getNonce).toHaveBeenCalled(); // the nonce branches need real counts
  });
});

describe("reconcilePending under a chain outage", () => {
  // Fail closed: if we cannot read the chain we must leave in-flight intents exactly as they are.
  // Marking them failed would re-drive a possibly-mined tx on the next cycle.
  it("propagates the read error and leaves the intent in flight", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const outage: ChainReader = {
      getReceiptStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      getNonce: async (_a, tag) => (tag === "latest" ? 9 : 9), // chain has moved well past nonce 5
      isKnown: async () => true,
    };

    await expect(reconcilePending({ store, signer: SIGNER, reader: outage })).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(store.all()[0].status).toBe("submitted"); // untouched — not "failed"
  });
});

describe("createChainReader", () => {
  // The reason `ChainReader` is a port rather than a bare `PublicClient`: a missing receipt is an
  // answer ("still in the mempool"), not an error, and viem signals it by throwing.
  it("maps viem's TransactionReceiptNotFoundError to null", async () => {
    const publicClient = {
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: "0xhash" });
      },
    } as unknown as PublicClient;

    expect(await createChainReader(publicClient).getReceiptStatus("0xhash")).toBeNull();
  });

  // An RPC outage must NOT read as "not mined". `reconcilePending` would see a nonce the chain has
  // moved past, mark a live intent failed/dropped, and re-drive a tx that may already be mined —
  // the exact double-submit this whole layer exists to prevent.
  it("propagates a transport error instead of reporting 'no receipt'", async () => {
    const publicClient = {
      getTransactionReceipt: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    } as unknown as PublicClient;

    await expect(createChainReader(publicClient).getReceiptStatus("0xhash")).rejects.toThrow(
      "ECONNREFUSED"
    );
  });

  it("maps receipt status and forwards the nonce block tag", async () => {
    const tags: string[] = [];
    const publicClient = {
      getTransactionReceipt: async () => ({ status: "reverted" }),
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => {
        tags.push(blockTag);
        return 42;
      },
    } as unknown as PublicClient;

    const chain = createChainReader(publicClient);
    expect(await chain.getReceiptStatus("0xhash")).toBe("reverted");
    expect(await chain.getNonce(SIGNER, "pending")).toBe(42);
    expect(tags).toEqual(["pending"]);
  });

  describe("isKnown", () => {
    const withTransaction = (getTransaction: () => unknown) =>
      createChainReader({ getTransaction } as unknown as PublicClient);

    it("is true when the node has the tx (mempool or mined)", async () => {
      expect(await withTransaction(async () => ({ hash: "0xhash" })).isKnown("0xhash")).toBe(true);
    });

    it("is false when the node has never seen the tx", async () => {
      const reader = withTransaction(async () => {
        throw new TransactionNotFoundError({ hash: "0xhash" });
      });
      expect(await reader.isKnown("0xhash")).toBe(false);
    });

    // `false` here would let reconcile conclude the broadcast was rejected and re-drive a
    // subject whose tx is actually in flight.
    it("propagates an RPC failure rather than reporting the tx as unknown", async () => {
      const reader = withTransaction(async () => {
        throw new Error("429 rate limited");
      });
      await expect(reader.isKnown("0xhash")).rejects.toThrow("429 rate limited");
    });
  });
});
