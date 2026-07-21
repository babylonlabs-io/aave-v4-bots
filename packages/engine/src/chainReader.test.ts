import {
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { describe, expect, it } from "vitest";
import { createChainReader } from "./chainReader";

const HASH = "0xhash" as Hex;

/** A `PublicClient` stub whose receipt/tx lookups resolve or throw as scripted. */
function client(receipt: () => unknown, transaction: () => unknown = () => ({ hash: HASH })) {
  return {
    async getTransactionReceipt() {
      return receipt();
    },
    async getTransaction() {
      return transaction();
    },
    async getTransactionCount() {
      return 0;
    },
  } as unknown as PublicClient;
}

describe("createChainReader", () => {
  it("maps a mined receipt to its status", async () => {
    const success = createChainReader(client(() => ({ status: "success" })));
    const reverted = createChainReader(client(() => ({ status: "reverted" })));

    expect(await success.getReceiptStatus(HASH)).toBe("success");
    expect(await reverted.getReceiptStatus(HASH)).toBe("reverted");
  });

  it("maps a genuinely missing receipt to null", async () => {
    const reader = createChainReader(
      client(() => {
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      })
    );

    expect(await reader.getReceiptStatus(HASH)).toBeNull();
  });

  it("propagates an RPC failure rather than reporting it as a missing receipt", async () => {
    // A rate-limited/unavailable provider must not look like "not mined": reconcile reads null
    // on a mined nonce as dropped/replaced and would re-open the subject for re-execution.
    const reader = createChainReader(
      client(() => {
        throw new Error("429 rate limited");
      })
    );

    await expect(reader.getReceiptStatus(HASH)).rejects.toThrow("429 rate limited");
  });

  describe("isKnown", () => {
    const noReceipt = () => {
      throw new TransactionReceiptNotFoundError({ hash: HASH });
    };

    it("is true when the node has the tx (mempool or mined)", async () => {
      const reader = createChainReader(client(noReceipt, () => ({ hash: HASH })));
      expect(await reader.isKnown(HASH)).toBe(true);
    });

    it("is false when the node has never seen the tx", async () => {
      const reader = createChainReader(
        client(noReceipt, () => {
          throw new TransactionNotFoundError({ hash: HASH });
        })
      );
      expect(await reader.isKnown(HASH)).toBe(false);
    });

    it("propagates an RPC failure rather than reporting the tx as unknown", async () => {
      // `false` here would let reconcile conclude the broadcast was rejected and re-drive a
      // subject whose tx is actually in flight.
      const reader = createChainReader(
        client(noReceipt, () => {
          throw new Error("429 rate limited");
        })
      );
      await expect(reader.isKnown(HASH)).rejects.toThrow("429 rate limited");
    });
  });
});
