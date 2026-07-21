import { type NonceAllocator, nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { IntentInput, IntentStatus, StateStore, TransitionMeta } from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";

import {
  type LivenessCheck,
  couldBeInFlight,
  createChainReader,
  reconcilePending,
} from "./reconcile";

// The crash-safety collaborator: the intent + shared-nonce-allocator dance both engines run
// around their sends. A collaborator rather than a base class, so each engine keeps its own
// pipeline and inherits nothing — and rather than free functions, because every one of them
// needed the same four fields (`store`, `nonces`, `publicClient`, `logger`) threaded through it
// at all sixteen call sites.
//
// Both `store` and `nonces` are optional. Absent, the operations degrade to no-ops or to viem's
// auto-nonce — which is what keeps persistence and the shared allocator opt-in, and what keeps
// that optionality out of `reconcilePending`'s algorithm.
//
// It is not *fully* hidden: the liquidation engine still branches on `allocated` to run its own
// nonce sequence when no allocator is injected. That branch is real behavior, not plumbing, so it
// stays visible at the call site rather than being smuggled in here.

export interface CrashSafetyConfig {
  /** Crash-safety store; absent ⇒ no intent tracking (reconcile and transitions no-op). */
  store?: StateStore;
  /** Shared nonce authority; absent ⇒ viem auto-nonce (behavior-preserving). */
  nonces?: NonceAllocator;
  publicClient: PublicClient;
  /** The sending address whose nonce sequence anchors reconcile's "was this broadcast?" checks. */
  signer: Address;
  logger: Logger;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** How long an unknown-to-the-node tx stays presumed-live; defaults to `UNKNOWN_TX_GRACE_MS`. */
  graceMs?: number;
}

export interface CrashSafety {
  /** Whether a shared nonce allocator is wired up (vs. the engine sequencing nonces itself). */
  readonly allocated: boolean;

  /**
   * Resolve one `action`'s in-flight intents against the chain (crash- and ambiguous-send
   * safety). No-op without a store.
   */
  reconcile(action: string): Promise<void>;

  /**
   * Re-seed the shared nonce lease (reclaims a not-broadcast nonce; advances if the chain moved
   * ahead), **fenced against transactions we know to be live**. No-op without an allocator.
   */
  resyncNonces(): Promise<void>;

  /**
   * Broadcast through the shared nonce allocator when present (so the two engines never collide
   * on a nonce), else let viem pick. `send` receives the reserved nonce, or `undefined` when
   * there is no allocator.
   */
  send(send: (nonce?: number) => Promise<Hex>): Promise<Hex>;

  /**
   * Claim the right to perform `input`, refusing a duplicate already live (pending or submitted)
   * on chain. On refusal the risk slot is released as `abandoned` — nothing was broadcast, so it
   * is not evidence the chain is rejecting us — and the caller skips the action.
   *
   * Without a store there is no idempotency to enforce: the claim succeeds with no intent id.
   */
  claim(slot: RiskSlot, input: IntentInput): Promise<{ claimed: boolean; intentId?: string }>;

  /**
   * Persist the reserved `nonce` — and, when the tx was signed locally, its `txHash` — on an
   * intent **before** its broadcast, so a crash or ambiguous send leaves an intent that
   * reconcile can resolve. With a hash it resolves by receipt lookup (exact); without one it
   * can only infer from the nonce, which is why senders sign first (see `TxSender`).
   *
   * Unlike `transition`, this deliberately **propagates** a failure: if we cannot record the
   * nonce we must not broadcast against it. No-op without a store.
   */
  markPending(id: string, nonce: number, txHash?: Hex): Promise<void>;

  /**
   * Intent transition that must not throw — a bookkeeping failure is logged, never propagated
   * (the on-chain tx is the source of truth; reconcile resolves any drift). No-op without a store.
   */
  transition(id: string, to: IntentStatus, meta?: TransitionMeta): Promise<void>;
}

export function createCrashSafety(config: CrashSafetyConfig): CrashSafety {
  const { store, nonces, publicClient, signer, logger, graceMs } = config;
  const reader = createChainReader(publicClient);
  const now = config.now ?? Date.now;
  const liveness: LivenessCheck = { reader, now, graceMs };

  /**
   * The lowest nonce `resync` may re-seed the lease to: one past the highest nonce held by a tx that
   * could still be on the wire. `0` when no such tx exists.
   *
   * `resync` sets the lease from the chain's `pending` count, and may move it *down* — that is how a
   * nonce reserved but never broadcast gets reclaimed rather than left as a permanent gap. This
   * floor bounds the pull-down: the lease may drop onto a nonce no live tx occupies, never onto one
   * that a live tx holds (signing over it would replace a liquidation already on the wire). The
   * bound is needed because `pending` is only as truthful as the provider — a node that does not
   * surface its mempool reports N while our tx sits at N.
   *
   * `couldBeInFlight` draws the line, and it is the same judgement `reconcilePending` makes: senders
   * record nonce **and** hash *before* broadcasting (`TxSender`), so a recorded hash proves only
   * that we signed. Sharing the predicate is what keeps the two from disagreeing — reconcile
   * re-driving an action whose nonce this still fences, or worse, this releasing a nonce reconcile
   * still believes is live.
   *
   * Spans **all** actions, not just the caller's: the arbitrageur's two engines share one signer,
   * hence one nonce sequence.
   */
  async function liveNonceFloor(): Promise<number> {
    if (!store) return 0;

    const live = await store.reconcile(); // every action — one signer, one nonce sequence
    const candidates = live.filter(
      (intent): intent is typeof intent & { nonce: number; txHash: Hex } =>
        intent.nonce !== null && intent.txHash !== null
    );
    // An intent with a nonce but no hash needs no fence: reconcile only leaves it live when
    // `pending > nonce`, so the chain's own count already sits above it.
    if (candidates.length === 0) return 0;

    // A probe failure propagates (as everywhere else in this layer): reading "unknown" from an RPC
    // blip would drop the fence and let the rewind through.
    const inFlight = await Promise.all(
      candidates.map((intent) =>
        couldBeInFlight(liveness, { txHash: intent.txHash, updatedAt: intent.updatedAt })
      )
    );
    return candidates.reduce(
      (floor, intent, i) => (inFlight[i] ? Math.max(floor, intent.nonce + 1) : floor),
      0
    );
  }

  return {
    allocated: nonces !== undefined,

    async reconcile(action) {
      if (!store) return;
      await reconcilePending({ store, reader, signer, action, logger, now, graceMs });
    },

    resyncNonces() {
      if (!nonces) return Promise.resolve();
      // Runs inside the allocator's lock, so nothing can reserve a nonce between these reads and
      // the SET they produce.
      return nonces.resync(async () => {
        const [chainPending, floor] = await Promise.all([
          nextNonce(publicClient, signer),
          liveNonceFloor(),
        ]);
        return Math.max(chainPending, floor);
      });
    },

    send(send) {
      return nonces ? nonces.withNonce((nonce) => send(nonce)) : send();
    },

    async claim(slot, input) {
      if (!store) return { claimed: true };

      const record = await store.recordIntent(input);
      if (!record.recorded) {
        logger.warn(`Skipping ${input.subject}: intent already ${record.existing.status}`);
        slot.settle({ ok: false, abandoned: true });
        return { claimed: false };
      }
      return { claimed: true, intentId: record.id };
    },

    async markPending(id, nonce, txHash) {
      if (!store) return;
      await store.transition(id, "pending", { nonce, ...(txHash ? { txHash } : {}) });
    },

    async transition(id, to, meta) {
      if (!store) return;
      try {
        await store.transition(id, to, meta);
      } catch (error) {
        logger.error(`Failed to persist intent ${id} → ${to}:`, error);
      }
    },
  };
}
