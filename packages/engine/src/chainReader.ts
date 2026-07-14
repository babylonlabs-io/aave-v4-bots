import type { ChainReader } from "@repo/persistence";
import { type PublicClient, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";

/**
 * Adapt a viem `PublicClient` to the persistence `ChainReader` (receipt status + nonce +
 * mempool knowledge) used by `reconcilePending`. A missing receipt/tx (viem throws) maps to
 * "not found"; every other error propagates — see `getReceiptStatus`.
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
    async isKnown(hash) {
      try {
        await publicClient.getTransaction({ hash });
        return true; // in the mempool or mined — either way, the chain has it
      } catch (error) {
        // Same discipline as above: only a genuine "unknown tx" is `false`. Reporting an RPC
        // failure as `false` would let reconcile conclude "the broadcast was rejected" and
        // re-drive a subject whose tx is in fact in flight.
        if (error instanceof TransactionNotFoundError) return false;
        throw error;
      }
    },
    getNonce: (address, blockTag) => publicClient.getTransactionCount({ address, blockTag }),
  };
}
