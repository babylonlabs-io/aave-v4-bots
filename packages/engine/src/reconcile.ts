import { getNonce, getReceiptStatus, isTxKnown } from "@repo/chain";
import type { Logger } from "@repo/logger";
import type { StateStore } from "@repo/persistence";
import type { Address, Hex, PublicClient } from "viem";

// Reconciliation is **orchestration**, not storage: it reads in-flight intents from the
// `StateStore`, asks the chain what became of them, and writes the resolution back. It spans two
// seams, so it belongs to the engine that coordinates them — `persistence` owns the `StateStore`
// port and nothing more, and `chain` owns the queries. Neither has to know the other exists.

/**
 * The chain reads `reconcilePending` needs, declared by the consumer that needs them.
 *
 * A port, not a `PublicClient`, so the algorithm can be exercised against a scripted chain and so
 * a future non-viem source (an RPC pool, an indexer, a replay harness) can satisfy it without
 * touching this file. `createChainReader` is the viem implementation; `@repo/chain` supplies the
 * raw queries and stays free of any interface declared on its callers' behalf.
 */
export interface ChainReader {
  /** Receipt status for `hash`, or `null` if the receipt is not found yet. */
  getReceiptStatus(hash: Hex): Promise<"success" | "reverted" | null>;
  /** Transaction count for `address` at `latest` (mined) or `pending` (mined + mempool). */
  getNonce(address: Address, tag: "latest" | "pending"): Promise<number>;
  /**
   * Does the node know this tx at all (mempool **or** mined)? Senders record the hash before
   * broadcasting, so a hash alone no longer proves the tx was accepted — this distinguishes
   * "in flight" from "signed, but the node rejected the broadcast (e.g. insufficient funds)".
   */
  isKnown(hash: Hex): Promise<boolean>;
}

/** Bind the `ChainReader` port to a viem `PublicClient`. */
export function createChainReader(publicClient: PublicClient): ChainReader {
  return {
    getReceiptStatus: (hash) => getReceiptStatus(publicClient, hash),
    getNonce: (address, tag) => getNonce(publicClient, address, tag),
    isKnown: (hash) => isTxKnown(publicClient, hash),
  };
}

export interface ReconcileSummary {
  examined: number;
  confirmed: number;
  failed: number;
  stillInFlight: number;
}

/**
 * Resolve the store's in-flight intents against the chain, **before** the engine re-drives —
 * the crux of no-double-submit after a crash or an ambiguous send. `signer` is the sending
 * address whose nonce sequence anchors the "was this broadcast?" checks.
 *
 * Senders sign locally and record `nonce` + `txHash` **before** broadcasting (see
 * `@repo/execution`'s `TxSender`), so the hash-bearing branch is the normal path: any intent
 * that could possibly exist on chain has its hash. The hash-less branches below are the
 * leftovers — the durable record itself failed, so nothing was broadcast.
 *
 * Per intent:
 * - **has a tx hash** → look up the receipt: `success` → `confirmed`, `reverted` → `failed`;
 *   no receipt but the signer's mined nonce has already passed the intent's nonce → the tx
 *   was dropped/replaced (or was signed and never broadcast, and something else took the
 *   slot) → `failed`; no receipt, the nonce slot is still free **and** the node does not know
 *   the hash → the broadcast was rejected, so nothing is on chain → `failed`, safe to
 *   re-drive; otherwise it is genuinely pending → left in-flight.
 * - **no hash, but a reserved nonce the chain has mined past** (`latest > nonce`) → a tx took
 *   that nonce slot; we can't fetch a receipt without the hash, so mark `failed` and let the
 *   engine's fresh simulation be the final guard (an already-executed action reverts in
 *   simulation and is skipped; a still-open one is re-driven).
 * - **no hash, reserved nonce still only in the mempool** (`pending > nonce >= latest`) → a
 *   broadcast we did not finish recording is likely in flight; keep it live (marked
 *   `submitted`) so this boot does **not** re-drive it — a later boot resolves it once mined.
 * - **never broadcast** (no nonce, or `pending <= nonce`) → `failed`, safe to re-drive.
 */
export async function reconcilePending(args: {
  store: StateStore;
  reader: ChainReader;
  signer: Address;
  /** Restrict to one action's intents (e.g. `"liquidation"`); omit for all. */
  action?: string;
  logger?: Pick<Logger, "info" | "warn">;
}): Promise<ReconcileSummary> {
  const { store, reader, signer, action, logger } = args;
  const inflight = await store.reconcile(action);
  const summary: ReconcileSummary = {
    examined: inflight.length,
    confirmed: 0,
    failed: 0,
    stillInFlight: 0,
  };
  if (inflight.length === 0) return summary;

  const [latest, pending] = await Promise.all([
    reader.getNonce(signer, "latest"),
    reader.getNonce(signer, "pending"),
  ]);

  for (const intent of inflight) {
    const { id, nonce, txHash } = intent;

    if (txHash) {
      const status = await reader.getReceiptStatus(txHash);
      if (status === "success") {
        await store.transition(id, "confirmed", { txHash });
        summary.confirmed++;
      } else if (status === "reverted") {
        await store.transition(id, "failed", { txHash, error: "reverted (reconciled)" });
        summary.failed++;
      } else if (nonce !== null && latest > nonce) {
        await store.transition(id, "failed", { txHash, error: "dropped/replaced (reconciled)" });
        summary.failed++;
      } else if (nonce !== null && pending <= nonce && !(await reader.isKnown(txHash))) {
        // The hash is recorded but the node has never heard of this tx AND its nonce slot is
        // still free — so the broadcast was *rejected* (insufficient funds, underpriced, …),
        // not merely unconfirmed. Nothing is on chain, so this is safe to re-drive. Without
        // this branch such an intent would be pinned live forever: a rejection that blocks one
        // send blocks them all, so no later tx would ever mine past the nonce to release it.
        await store.transition(id, "failed", { txHash, error: "not accepted (reconciled)" });
        summary.failed++;
      } else {
        summary.stillInFlight++;
      }
      continue;
    }

    if (nonce !== null && latest > nonce) {
      // A tx already occupies this nonce; without the hash we resolve to failed and lean on
      // the engine's on-chain simulation to avoid re-executing an already-done action.
      await store.transition(id, "failed", { error: "nonce mined without recorded hash" });
      summary.failed++;
    } else if (nonce !== null && pending > nonce) {
      // Likely in the mempool — keep it live so this boot does not re-drive it. Without a
      // hash we can't confirm it; if such a tx never mines and never drops, the intent stays
      // live across boots and this subject is refused until then (no-double-submit is favored
      // over liveness). Warn so a stuck position is observable to an operator.
      await store.transition(id, "submitted", { error: "broadcast unconfirmed on boot" });
      logger?.warn(
        `Reconcile: ${intent.action} ${intent.subject} kept in-flight — nonce ${nonce} in mempool, no recorded tx hash`
      );
      summary.stillInFlight++;
    } else {
      await store.transition(id, "failed", { error: "not broadcast (reconciled)" });
      summary.failed++;
    }
  }

  logger?.info(
    `Reconcile: ${summary.examined} in-flight → ${summary.confirmed} confirmed, ` +
      `${summary.failed} failed, ${summary.stillInFlight} still in-flight`
  );
  return summary;
}
