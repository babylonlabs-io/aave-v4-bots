import { type IntentInput, createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import { type Address, type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";

import { type ChainReader, createChainReader, reconcilePending } from "./reconcile";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
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

  it("no-ops with nothing in flight", async () => {
    const store = createMemoryStateStore();
    const summary = await reconcilePending({ store, signer: SIGNER, reader: reader({}) });
    expect(summary.examined).toBe(0);
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
});
