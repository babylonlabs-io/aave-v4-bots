import type { NonceAllocator } from "@repo/execution";
import type { Logger } from "@repo/logger";
import {
  type IntentInput,
  type IntentStatus,
  type StateStore,
  type TransitionExpectation,
  type TransitionMeta,
  type TxIntent,
  isSigned,
} from "@repo/persistence";
import type { Address, Hex } from "viem";

import { type ChainReader, type LivenessCheck, couldBeInFlight } from "./liveness";
import { reconcilePending } from "./reconcile";

// The crash-safety collaborator: the intent + shared-nonce-allocator dance both engines run
// around their sends. A collaborator rather than a base class, so each engine keeps its own
// pipeline and inherits nothing — and rather than free functions, because every one of them
// needed the same four fields (`store`, `nonces`, `reader`, `logger`) threaded through it
// at all sixteen call sites.
//
// `store` is optional (absent ⇒ no intent tracking, operations no-op), which keeps persistence
// opt-in and out of `reconcilePending`'s algorithm. The **nonce allocator is mandatory** and is the
// sole nonce source: every signer tx goes through it, so the two engines a single process runs (the
// arbitrageur) can never collide on a nonce. Sequencing a nonce per-send off the chain instead would
// be incorrect for that dual-engine case — both engines would read the same count and collide — not
// merely slower.

export interface CrashSafetyConfig {
  /** Crash-safety store; absent ⇒ no intent tracking (reconcile and transitions no-op). */
  store?: StateStore;
  /** The shared nonce authority — every signer tx routes through it (no two engines collide). */
  nonces: NonceAllocator;
  /**
   * Everything this asks of the chain: the pending nonce, receipts, and whether a tx is known.
   * `createChainReader(publicClient)` is the ordinary answer.
   *
   * Required rather than defaulted, because under private submission the node-backed answer is
   * wrong by construction — our own node cannot see the transaction. See `createRelayAwareReader`.
   */
  reader: ChainReader;
  /** See `LivenessCheck.reclaimMarginBlocks`. Travels with `reader`, which fails closed without it. */
  reclaimMarginBlocks?: number;
  /** The sending address whose nonce sequence anchors reconcile's "was this broadcast?" checks. */
  signer: Address;
  logger: Logger;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** How long an unknown-to-the-node tx stays presumed-live; defaults to `UNKNOWN_TX_GRACE_MS`. */
  graceMs?: number;
}

export interface CrashSafety {
  /**
   * Resolve this signer's in-flight intents against the chain (crash- and ambiguous-send safety).
   *
   * Unscoped by action, because an intent belongs to the **signer**, not to the engine that created
   * it — the same assumption `liveNonceFloor` already makes when it spans every action. Scoping it
   * would strand any action no engine owns (`approval`), and a stranded approval intent makes every
   * later `ensureAllowance` a duplicate. No-op without a store.
   */
  reconcile(): Promise<void>;

  /**
   * Re-seed the shared nonce lease (reclaims a not-broadcast nonce; advances if the chain moved
   * ahead), **fenced against transactions we know to be live**.
   */
  resyncNonces(): Promise<void>;

  /**
   * Broadcast under the shared nonce lock, so the two engines never collide on a nonce. `send`
   * receives the reserved nonce.
   */
  send(send: (nonce: number) => Promise<Hex>): Promise<Hex>;

  /**
   * Claim the right to perform `input`, refusing (`claimed: false`) a duplicate already live
   * (pending or submitted) on chain. **Does not settle the risk slot** — settling exposure is the
   * caller's job on every path (a refused claim is settled `abandoned`: nothing was broadcast, so
   * it is not evidence the chain is rejecting us). On refusal `existing` carries the live intent.
   *
   * Without a store there is no idempotency to enforce: the claim succeeds with no intent id.
   */
  claim(input: IntentInput): Promise<{
    claimed: boolean;
    intentId?: string;
    /** This attempt's version token — hand it to `markPending`. See `RecordResult.attemptAt`. */
    attemptAt?: number;
    existing?: TxIntent;
  }>;

  /**
   * Persist the reserved `nonce` — and, when the tx was signed locally, its `txHash` — on an
   * intent **before** its broadcast, so a crash or ambiguous send leaves an intent that
   * reconcile can resolve. With a hash it resolves by receipt lookup (exact); without one it
   * can only infer from the nonce, which is why senders sign first (see `TxSender`).
   *
   * Unlike `transition`, this deliberately **propagates** a failure: if we cannot record the
   * nonce we must not broadcast against it. That includes the write being *refused*: `attemptAt`
   * binds it to the attempt that was claimed, and a refusal means the row has since been resolved
   * and revived as someone else's attempt. Broadcasting then would put this transaction on chain
   * with its nonce and hash recorded against a different try — invisible to the nonce fence, which
   * only fences rows carrying both. No-op without a store.
   */
  markPending(id: string, nonce: number, attemptAt: number, txHash?: Hex): Promise<void>;

  /**
   * Intent transition that must not throw — a bookkeeping failure is logged, never propagated
   * (the on-chain tx is the source of truth; reconcile resolves any drift). No-op without a store.
   */
  transition(
    id: string,
    to: IntentStatus,
    meta?: TransitionMeta,
    /** Bind the write to the row the caller observed — see `StateStore.transition`. */
    expect?: TransitionExpectation
  ): Promise<void>;
}

export function createCrashSafety(config: CrashSafetyConfig): CrashSafety {
  const { store, nonces, reader, signer, logger, graceMs } = config;
  const now = config.now ?? Date.now;
  const liveness: LivenessCheck = {
    reader,
    now,
    graceMs,
    reclaimMarginBlocks: config.reclaimMarginBlocks,
  };

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
  async function liveNonces(head?: number): Promise<Set<number>> {
    if (!store) return new Set();

    const live = await store.reconcile(); // every action — one signer, one nonce sequence
    const candidates = live.filter(isSigned);
    // An intent with a nonce but no hash needs no fence: reconcile only leaves it live when
    // `pending > nonce`, so the chain's own count already sits above it.
    if (candidates.length === 0) return new Set();

    // A probe failure propagates (as everywhere else in this layer): reading "unknown" from an RPC
    // blip would drop the fence and let the rewind through.
    const inFlight = await Promise.all(
      candidates.map((intent) =>
        couldBeInFlight(
          { ...liveness, head },
          {
            txHash: intent.txHash,
            updatedAt: intent.updatedAt,
            relayMaxBlock: intent.relayMaxBlock,
          }
        )
      )
    );
    return new Set(candidates.filter((_, i) => inFlight[i]).map((intent) => intent.nonce));
  }

  return {
    async reconcile() {
      if (!store) return;
      await reconcilePending({
        store,
        reader,
        signer,
        logger,
        now,
        graceMs,
        reclaimMarginBlocks: config.reclaimMarginBlocks,
      });
    },

    resyncNonces() {
      // Runs inside the allocator's lock, so nothing can reserve a nonce between these reads and
      // the SET they produce.
      return nonces.resync(async () => {
        // Head once per pass, so every intent's horizon is judged against the same block, and only
        // when a horizon can decide anything.
        const [chainPending, head] = await Promise.all([
          reader.getNonce(signer, "pending"),
          config.reclaimMarginBlocks === undefined ? undefined : reader.getBlockNumber(),
        ]);
        const live = await liveNonces(head);
        const floor = live.size === 0 ? 0 : Math.max(...live) + 1;
        const next = Math.max(chainPending, floor);

        // A hole: the chain's next executable nonce sits below our floor and nothing live holds it,
        // so everything signed above it is queued until it is filled — and the lease never comes
        // back down on its own. `!live.has(chainPending)` is what separates filling a dead hole
        // from signing over a transaction that may still land.
        const reclaimable =
          next > chainPending && !live.has(chainPending) ? chainPending : undefined;
        if (reclaimable !== undefined) {
          logger.warn(
            `Nonce ${reclaimable} is a hole: nothing live holds it and ${live.size} later transaction(s) are queued behind it. Reissuing it so they can mine.`
          );
        }
        return { next, reclaimable };
      });
    },

    send(send) {
      return nonces.withNonce((nonce) => send(nonce));
    },

    async claim(input) {
      if (!store) return { claimed: true };

      const record = await store.recordIntent(input);
      if (!record.recorded) {
        logger.warn(`Skipping ${input.subject}: intent already ${record.existing.status}`);
        return { claimed: false, existing: record.existing };
      }
      return { claimed: true, intentId: record.id, attemptAt: record.attemptAt };
    },

    async markPending(id, nonce, attemptAt, txHash) {
      if (!store) return;
      const applied = await store.transition(
        id,
        "pending",
        { nonce, ...(txHash ? { txHash } : {}) },
        { updatedAt: attemptAt }
      );
      if (!applied) {
        throw new Error(
          `intent ${id} is no longer the attempt this send claimed — refusing to broadcast at nonce ${nonce}. Another reconcile resolved it and the row was revived for a new attempt; this transaction's nonce and hash would be recorded against that one.`
        );
      }
    },

    async transition(id, to, meta, expect) {
      if (!store) return;
      try {
        await store.transition(id, to, meta, expect);
      } catch (error) {
        logger.error(`Failed to persist intent ${id} → ${to}:`, error);
      }
    },
  };
}
