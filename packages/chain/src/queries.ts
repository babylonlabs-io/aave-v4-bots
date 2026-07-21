import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  keccak256,
} from "viem";

// Chain queries: plain functions over a viem `PublicClient`, offered to whoever needs them.
// `chain` sits at the bottom of the graph — it imports nothing from a sibling package, not even a
// type, and declares no interface on any consumer's behalf.

/**
 * keccak256 of the deployed bytecode at `address`, or `undefined` when the account has no code.
 * Consumed by the risk gate's code-hash guard.
 *
 * One address per call, deliberately: the caller must be able to judge the addresses it *could*
 * read even when another is unreadable. Batching here (`Promise.all`) would let one bad RPC
 * response mask a real bytecode mismatch on a different address.
 *
 * Errors are **not** swallowed: to the gate, a failed probe (RPC blip) must be distinguishable
 * from "no code here", which it treats as compromise and halts on.
 */
export async function readCodeHash(
  publicClient: PublicClient,
  address: string
): Promise<string | undefined> {
  const code = await publicClient.getCode({ address: address as Address });
  // viem returns `undefined` for an EOA/empty account; some nodes return "0x".
  if (code === undefined || code === "0x") return undefined;
  return keccak256(code);
}

/**
 * Receipt status for `hash`, or `null` when the chain says there is no receipt yet — which is what
 * distinguishes "still in the mempool" from "mined". viem signals that by throwing
 * `TransactionReceiptNotFoundError`; that is not an error here, it is the answer.
 *
 * Every **other** error propagates. Collapsing an RPC outage into `null` would let a caller read
 * it as "not mined": `reconcilePending` would then see a nonce the chain has moved past, mark a
 * live intent `failed (dropped/replaced)`, and re-drive a transaction that may already be mined.
 * An unreachable node must fail the reconcile, not silently invent an answer for it.
 */
export async function getReceiptStatus(
  publicClient: PublicClient,
  hash: Hex
): Promise<"success" | "reverted" | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null; // not mined yet
    throw error; // transport / RPC failure — the caller must not treat this as "not mined"
  }
}

/**
 * Does the node know this tx at all — mempool **or** mined? Senders sign locally and record the
 * hash *before* broadcasting, so a recorded hash no longer proves the tx was accepted; this is
 * what separates "in flight" from "signed, but the node rejected the broadcast".
 *
 * Same discipline as `getReceiptStatus`: only a genuine `TransactionNotFoundError` is `false`.
 * Reporting an RPC failure as `false` would let `reconcilePending` conclude the broadcast was
 * rejected and re-drive a subject whose tx is in fact in flight.
 */
export async function isTxKnown(publicClient: PublicClient, hash: Hex): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch (error) {
    if (error instanceof TransactionNotFoundError) return false;
    throw error; // transport / RPC failure — the caller must not treat this as "unknown tx"
  }
}

/** Transaction count for `address` at `latest` (mined) or `pending` (mined + mempool). */
export function getNonce(
  publicClient: PublicClient,
  address: Address,
  blockTag: "latest" | "pending"
): Promise<number> {
  return publicClient.getTransactionCount({ address, blockTag });
}
