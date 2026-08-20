import type { Address, PublicClient } from "viem";

/** Nonce to use for the next transaction from `address` (includes pending txs). */
export function nextNonce(client: PublicClient, address: Address): Promise<number> {
  return client.getTransactionCount({ address, blockTag: "pending" });
}

// ── Shared nonce authority ────────────────────────────────────────────────────────────
//
// One signer, possibly two engines (arbitrageur runs both) polling concurrently. A single
// `NonceAllocator` — shared across engines — is the sole nonce owner. Correctness rests on two
// things: an in-process **mutex** (so two engines never reserve the same nonce) and **re-seeding
// from the chain** (`resync`), which makes the chain the source of truth across restarts. Intent
// idempotency is a separate concern and lives in `@repo/persistence`.
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

/**
 * What a resync learned. A bare number is "the next nonce is N" and is what public submission always
 * reports; the object form additionally names a **hole** — a nonce below `next` that nothing live
 * holds and that therefore has to be handed out again, or every later transaction queues behind it
 * forever.
 *
 * Holes are re-derived on every resync rather than accumulated in a free-list, so the set can never
 * go stale: once the hole is filled the chain's own count advances past it and no hole is reported.
 */
export type NonceSeed = number | { next: number; reclaimable?: number };

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
  resync(readChainNonce: () => Promise<NonceSeed>): Promise<void>;
}

/**
 * Build the shared nonce authority for `signer`. The lock is a promise chain: each critical
 * section (`withNonce` body or `resync`) awaits the previous one, so reserve/broadcast/resync
 * never interleave and a rejection does not poison later sections.
 */
export function createNonceAllocator(lease: NonceLease, signer: Address): NonceAllocator {
  let tail: Promise<unknown> = Promise.resolve();
  /**
   * A nonce below the lease that nothing live holds, handed out before the lease advances again.
   *
   * The lease is a monotonic counter and the fence a high-water mark, so releasing a dead nonce
   * never brings the counter back down to it. Public submission hides this — a mempool evicts a
   * dropped transaction's dependents and the floor collapses on its own — but a private one was
   * never in a mempool, so the hole is permanent.
   */
  let reclaimable: number | undefined;
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
        // Fill a known hole first: everything already signed above it is unmineable until it lands.
        const hole = reclaimable;
        if (hole !== undefined) reclaimable = undefined;
        const nonce = hole ?? (await lease.reserve(signer));
        return send(nonce); // no rollback: an error propagates; the nonce is reclaimed via resync
      });
    },
    resync(readChainNonce) {
      return exclusive(async () => {
        // Read the chain WHILE holding the lock, so the SET reflects any broadcast that just
        // completed (no lost update against a concurrent `withNonce`).
        const seed = await readChainNonce();
        const next = typeof seed === "number" ? seed : seed.next;
        // Recomputed from this cycle's evidence, never accumulated: a hole that has since been
        // filled simply is not reported again, so there is no stale free-list to go wrong.
        const hole = typeof seed === "number" ? undefined : seed.reclaimable;
        reclaimable = hole !== undefined && hole < next ? hole : undefined;
        await lease.set(signer, next);
      });
    },
  };
}
