import type { ChainReader } from "@repo/persistence";
import type { PublicClient } from "viem";

/**
 * Adapt a viem `PublicClient` to the persistence `ChainReader` (receipt status + nonce) used
 * by `reconcilePending`. A missing receipt (viem throws) maps to `null` ("not found yet").
 */
export function createChainReader(publicClient: PublicClient): ChainReader {
  return {
    async getReceiptStatus(hash) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        return receipt.status === "success" ? "success" : "reverted";
      } catch {
        return null; // receipt not found yet
      }
    },
    getNonce: (address, blockTag) => publicClient.getTransactionCount({ address, blockTag }),
  };
}
