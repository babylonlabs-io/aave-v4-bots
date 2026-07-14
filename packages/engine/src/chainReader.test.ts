import { type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { createChainReader } from "./chainReader";

const HASH = "0xhash" as Hex;

/** A `PublicClient` stub whose `getTransactionReceipt` resolves or throws as scripted. */
function client(receipt: () => unknown): PublicClient {
  return {
    async getTransactionReceipt() {
      return receipt();
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
});
