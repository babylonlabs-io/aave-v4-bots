import { createLogger } from "@repo/logger";
import type { Address, Hex, PublicClient } from "viem";

const logger = createLogger();

// Transaction execution primitives — nonce sourcing and receipt-waiting. The
// service keeps its own send loop / nonce sequencing / retry orchestration; these
// are the shared building blocks.

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

/** Nonce to use for the next transaction from `address` (includes pending txs). */
export function nextNonce(client: PublicClient, address: Address): Promise<number> {
  return client.getTransactionCount({ address, blockTag: "pending" });
}

// ── Shared nonce authority ────────────────────────────────────────────────────────────
//
// One signer, possibly two engines (arbitrageur runs both) polling concurrently. A single
// `NonceAllocator` — shared across engines — is the sole nonce owner. Correctness comes from
// two things, neither needing persistence: an in-process **mutex** (so two engines never
// reserve the same nonce) and **re-seeding from the chain** (`resync`, so the chain is the
// source of truth and a restart needs no persisted counter). Persistence, when present, is a
// separate concern (intent idempotency) and lives in `@repo/persistence`.
//
// **No rollback:** a thrown `send` does not prove the tx was not broadcast (an RPC timeout can
// fire after the node accepted it), so the reserved nonce is NOT reused within the cycle; the
// next cycle's `resync` reclaims it from the chain only if the chain shows it free.

/**
 * Where the next-nonce counter lives. In-memory for the single-instance cut; a DB-backed,
 * row-locked implementation is the seam for a future multi-process deployment. `reserve`
 * requires the lease to have been seeded (via `set`/the allocator's `resync`) — throws otherwise.
 */
export interface NonceLease {
  /** Return the current next-nonce for `signer` and advance the counter by one. */
  reserve(signer: Address): Promise<number>;
  /** Set the next-nonce for `signer` (seed at boot / re-seed each cycle / reclaim). */
  set(signer: Address, value: number): Promise<void>;
}

/** Default in-memory `NonceLease` (per-signer counter). */
export function createNonceLease(): NonceLease {
  const next = new Map<string, number>();
  return {
    async reserve(signer) {
      const key = signer.toLowerCase();
      const value = next.get(key);
      if (value === undefined) {
        throw new Error(`nonce lease for ${signer} is not seeded (resync first)`);
      }
      next.set(key, value + 1);
      return value;
    },
    async set(signer, value) {
      next.set(signer.toLowerCase(), value);
    },
  };
}

export interface NonceAllocator {
  /**
   * Reserve the next nonce and run `send` under the per-signer lock. `send(nonce)` MUST do
   * only the durable pre-broadcast recording (if any) + the broadcast, returning the hash —
   * no receipt wait (it holds the lock). On throw the outcome is UNKNOWN: the nonce is not
   * reused this cycle and the error propagates (the caller stops sending); the next cycle's
   * `resync` reclaims it from the chain iff it is free.
   */
  withNonce<T>(send: (nonce: number) => Promise<T>): Promise<T>;
  /**
   * Re-align the lease to the chain's `pending` nonce (SET). `readChainNonce` is invoked
   * **inside** the lock — this is essential: reading the chain outside the lock and passing a
   * value in would let a concurrent `withNonce` advance the lease between the read and the
   * SET, rewinding it and reusing a nonce. Call once at boot and at each cycle start.
   */
  resync(readChainNonce: () => Promise<number>): Promise<void>;
}

/**
 * Build the shared nonce authority for `signer`. The lock is a promise chain: each critical
 * section (`withNonce` body or `resync`) awaits the previous one, so reserve/broadcast/resync
 * never interleave and a rejection does not poison later sections.
 */
export function createNonceAllocator(lease: NonceLease, signer: Address): NonceAllocator {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    // Swallow rejections for the chain only — the returned promise keeps the real error.
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  return {
    withNonce(send) {
      return exclusive(async () => {
        const nonce = await lease.reserve(signer);
        return send(nonce); // no rollback: an error propagates; the nonce is reclaimed via resync
      });
    },
    resync(readChainNonce) {
      return exclusive(async () => {
        // Read the chain WHILE holding the lock, so the SET reflects any broadcast that just
        // completed (no lost update against a concurrent `withNonce`).
        const chainPendingNonce = await readChainNonce();
        await lease.set(signer, chainPendingNonce);
      });
    },
  };
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
