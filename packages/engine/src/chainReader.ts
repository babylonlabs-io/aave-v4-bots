import type { ChainReader } from "@repo/persistence";
import { type PublicClient, TransactionReceiptNotFoundError } from "viem";

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
      } catch (error) {
        // Only a genuine "no receipt" is `null`. An RPC failure (rate limit, timeout, bad
        // response) must propagate: reconcile reads `null` on a mined nonce as dropped/replaced
        // and would mark a mined intent `failed`, re-opening its subject for re-execution.
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    getNonce: (address, blockTag) => publicClient.getTransactionCount({ address, blockTag }),
  };
}
