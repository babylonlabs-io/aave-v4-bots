import { type NonceAllocator, nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { IntentInput, IntentStatus, StateStore, TransitionMeta } from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";

import { createChainReader, reconcilePending } from "./reconcile";

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
   * Re-seed the shared nonce lease from the chain's `pending` count (reclaims a not-broadcast
   * nonce; advances if the chain moved ahead). No-op without an allocator.
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
  const { store, nonces, publicClient, signer, logger } = config;
  const reader = createChainReader(publicClient);

  return {
    allocated: nonces !== undefined,

    async reconcile(action) {
      if (!store) return;
      await reconcilePending({ store, reader, signer, action, logger });
    },

    resyncNonces() {
      return nonces ? nonces.resync(() => nextNonce(publicClient, signer)) : Promise.resolve();
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
