import { createLogger } from "@repo/logger";
import type { Address, Hex, PublicClient } from "viem";

const logger = createLogger();

// Transaction execution primitives — nonce sourcing and receipt-waiting. The
// service keeps its own send loop / nonce sequencing / retry orchestration; these
// are the shared building blocks (proposal §6 — execution).

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

/** Nonce to use for the next transaction from `address` (includes pending txs). */
export function nextNonce(client: PublicClient, address: Address): Promise<number> {
  return client.getTransactionCount({ address, blockTag: "pending" });
}

const RECEIPT_TIMEOUT_MESSAGE = "Transaction receipt timeout";

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(RECEIPT_TIMEOUT_MESSAGE)), ms);
  });
}

/**
 * Wait for `hash`'s receipt, returning `null` if `timeoutMs` elapses first rather
 * than hanging. Non-timeout errors are re-thrown.
 */
export async function waitForReceipt(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number
): Promise<Receipt | null> {
  try {
    return await Promise.race([client.waitForTransactionReceipt({ hash }), rejectAfter(timeoutMs)]);
  } catch (error) {
    if (error instanceof Error && error.message === RECEIPT_TIMEOUT_MESSAGE) {
      return null;
    }
    throw error;
  }
}

/**
 * `waitForReceipt` that also logs a warning on timeout (prefixed with an
 * optional `context` label, matching `@repo/chain`'s `withRetry`). Returns `null` on
 * timeout, re-throws other errors.
 */
export async function waitForReceiptWithTimeout(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number,
  context?: string
): Promise<Receipt | null> {
  const receipt = await waitForReceipt(client, hash, timeoutMs);
  if (receipt === null) {
    const prefix = context ? `${context} ` : "";
    logger.warn(`${prefix}Timeout waiting for transaction ${hash} after ${timeoutMs}ms`);
  }
  return receipt;
}
