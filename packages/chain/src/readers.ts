import type { ChainReader } from "@repo/persistence";
import type { CodeHashReader } from "@repo/risk";
import { type Address, type PublicClient, keccak256 } from "viem";

// Adapters from a viem `PublicClient` onto the ports other packages declare. They live here
// rather than in the packages that own those ports (which stay viem-free) or in `@repo/engine`
// (which holds no adapter code — see production-architecture-modules §5.2). Both port imports
// are type-only, so neither package is pulled in at runtime.

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

/**
 * Adapt a viem `PublicClient` to the risk `CodeHashReader`, so `@repo/risk` can guard against a
 * target contract being upgraded or self-destructed under it without depending on viem.
 *
 * Errors are **not** swallowed: to the gate, a failed probe (RPC blip) must be distinguishable
 * from "no code here", which it treats as compromise and halts on.
 */
export function createCodeHashReader(publicClient: PublicClient): CodeHashReader {
  return {
    async getCodeHash(address) {
      const code = await publicClient.getCode({ address: address as Address });
      // viem returns `undefined` for an EOA/empty account; some nodes return "0x".
      if (code === undefined || code === "0x") return undefined;
      return keccak256(code);
    },
  };
}
