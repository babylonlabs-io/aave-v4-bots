import type {
  IntentStatus,
  SafeEnvelope,
  StateStore,
  TransitionMeta,
  TxIntent,
} from "@repo/persistence";
import type { Address, Hex } from "viem";

import type { Logger } from "@repo/logger";
import {
  type ChainReader,
  type LivenessCheck,
  UNKNOWN_TX_GRACE_MS,
  couldBeInFlight,
} from "./liveness";

// Boot/cycle reconcile: resolve persisted in-flight intents against the chain before the engine
// re-drives anything. The liveness question it leans on lives in `./liveness`, shared with the
// nonce fence so the two can never disagree about whether a transaction is still out there.
//
// Reconciliation is **orchestration**, not storage: it reads in-flight intents from the
// `StateStore`, asks the chain what became of them, and writes the resolution back. It spans two
// seams, so it belongs to the engine that coordinates them — `persistence` owns the `StateStore`
// port and nothing more, and `chain` owns the queries. Neither has to know the other exists.

/** What one `reconcilePending` pass resolved. */
export interface ReconcileSummary {
  examined: number;
  confirmed: number;
  failed: number;
  stillInFlight: number;
}

/**
 * What a resolver decided for one intent, kept separate from applying it: the `status` to write (or
 * none — a genuinely-pending intent is left untouched), which summary counter to `bucket`, and an
 * optional operator `warn`. This makes each resolver a small function with no store/log side-effects
 * — the loop owns those — so the resolution logic reads and tests in isolation.
 */
interface Resolution {
  status?: IntentStatus;
  meta?: TransitionMeta;
  bucket: "confirmed" | "failed" | "stillInFlight";
  warn?: string;
}

const confirmedAs = (meta: TransitionMeta): Resolution => ({
  status: "confirmed",
  meta,
  bucket: "confirmed",
});
const failedAs = (meta: TransitionMeta): Resolution => ({
  status: "failed",
  meta,
  bucket: "failed",
});

/** Genuinely in flight — leave the row as-is, just count it. */
const stillInFlight: Resolution = { bucket: "stillInFlight" };

/**
 * MANUAL + `safe`: the outer `execTransaction` receipt lies about the inner call (a Safe catches an
 * inner revert and still succeeds), so judge by the Safe's `Execution{Success,Failure}` event — see
 * the ladder in `SafeExecutionOutcome`.
 */
async function resolveSafeIntent(
  reader: ChainReader,
  safe: Address,
  intent: TxIntent,
  txHash: Hex,
  envelope: SafeEnvelope
): Promise<Resolution> {
  const outcome = await reader.getSafeExecution(txHash, safe, envelope.safeTxHash);
  switch (outcome) {
    case "success":
      return confirmedAs({ txHash });
    case "failure":
      return failedAs({ txHash, error: "Safe inner call reverted (ExecutionFailure)" });
    case "reverted":
      return failedAs({ txHash, error: "Safe execTransaction reverted" });
    case "no-event":
      // Mined, status 1, yet no matching Execution event — anomalous. Fail (safe: the engine's fresh
      // simulation guards against re-executing an action that did land) and warn loudly, rather than
      // confirm blind or leave it looping forever.
      return {
        ...failedAs({ txHash, error: "Safe tx mined without a matching Execution event" }),
        warn: `Reconcile: ${intent.action} ${intent.subject} — Safe tx ${txHash} carries no Execution event for ${envelope.safeTxHash}`,
      };
    default:
      return stillInFlight;
  }
}

/**
 * EOA / AUTO with a recorded hash — the normal path (senders record `nonce` + `txHash` before
 * broadcasting). The receipt status *is* the inner call's, since the account called the target
 * directly: `success` → confirmed, `reverted` → failed; else fall to the nonce-based liveness checks.
 */
async function resolveBroadcastIntent(
  liveness: LivenessCheck,
  nonces: { latest: number; pending: number },
  intent: TxIntent,
  txHash: Hex
): Promise<Resolution> {
  const { nonce, updatedAt } = intent;
  const status = await liveness.reader.getReceiptStatus(txHash);
  if (status === "success") return confirmedAs({ txHash });
  if (status === "reverted") return failedAs({ txHash, error: "reverted (reconciled)" });
  // No receipt, but the signer's mined nonce has passed this one → the tx was dropped/replaced (or
  // signed-but-never-broadcast and something else took the slot).
  if (nonce !== null && nonces.latest > nonce) {
    return failedAs({ txHash, error: "dropped/replaced (reconciled)" });
  }
  // The nonce slot is still free and the node has not heard of this tx for long enough that
  // propagation cannot explain it — so the broadcast was *rejected* (insufficient funds, underpriced,
  // …), not merely unconfirmed. Nothing is on chain, so this is safe to re-drive. Without this an
  // intent would pin live forever: a rejection that blocks one send blocks them all, so no later tx
  // would ever mine past the nonce to release it.
  if (
    nonce !== null &&
    nonces.pending <= nonce &&
    !(await couldBeInFlight(liveness, { txHash, updatedAt, relayMaxBlock: intent.relayMaxBlock }))
  ) {
    return failedAs({ txHash, error: "not accepted (reconciled)" });
  }
  return stillInFlight;
}

/**
 * No recorded hash — the durable record itself failed mid-send, so resolution leans on the reserved
 * nonce. `latest > nonce`: a tx took the slot; without a hash we can't fetch a receipt, so `failed`
 * and let the engine's fresh simulation be the final guard. `pending > nonce`: likely in the mempool
 * — keep it live (`submitted`) so this boot does not re-drive it; a later boot resolves it once mined.
 * Otherwise it was never broadcast → `failed`, safe to re-drive.
 */
function resolveUnbroadcastIntent(
  liveness: LivenessCheck,
  nonces: { latest: number; pending: number },
  intent: TxIntent
): Resolution {
  const { nonce } = intent;

  // `pending` with neither nonce nor hash is an intent being signed right now: `recordIntent` writes
  // it before `signContractCall`, and `markPending` fills both in only once signing returns. A
  // *failed* send does not look like this — `commit` moves it to `submitted` first. Age separates it
  // from a crash leftover; without the guard one engine marks another's in-progress claim `failed`
  // and frees its subject mid-send.
  if (
    intent.status === "pending" &&
    nonce === null &&
    intent.txHash === null &&
    liveness.now() - intent.updatedAt < (liveness.graceMs ?? UNKNOWN_TX_GRACE_MS)
  ) {
    return stillInFlight;
  }
  if (nonce !== null && nonces.latest > nonce) {
    return failedAs({ error: "nonce mined without recorded hash" });
  }
  if (nonce !== null && nonces.pending > nonce) {
    return {
      status: "submitted",
      meta: { error: "broadcast unconfirmed on boot" },
      bucket: "stillInFlight",
      warn: `Reconcile: ${intent.action} ${intent.subject} kept in-flight — nonce ${nonce} in mempool, no recorded tx hash`,
    };
  }
  return failedAs({ error: "not broadcast (reconciled)" });
}

/**
 * Resolve the store's in-flight intents against the chain, **before** the engine re-drives — the
 * crux of no-double-submit after a crash or an ambiguous send. `signer` is the sending address whose
 * nonce sequence anchors the "was this broadcast?" checks (and, in `safe` custody, the Safe whose
 * `Execution*` event confirms). Each intent is routed to one of three resolvers by what it carries —
 * a Safe envelope, a plain tx hash, or neither — and the decision is applied here.
 */
export async function reconcilePending(args: {
  store: StateStore;
  reader: ChainReader;
  signer: Address;
  logger?: Pick<Logger, "info" | "warn">;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** How long an unknown-to-the-node tx stays presumed-live; defaults to `UNKNOWN_TX_GRACE_MS`. */
  graceMs?: number;
  /**
   * See `LivenessCheck.reclaimMarginBlocks`. Passed through so this and the nonce fence answer
   * "could this still be on the wire?" the same way — the whole reason `couldBeInFlight` is shared.
   * Without it a privately-submitted transaction past its horizon is released by the fence but
   * still counted live here, so its intent never resolves and its subject stays blocked forever.
   */
  reclaimMarginBlocks?: number;
}): Promise<ReconcileSummary> {
  const { store, reader, signer, logger, graceMs, reclaimMarginBlocks } = args;
  const now = args.now ?? Date.now;
  const inflight = await store.reconcile();
  const summary: ReconcileSummary = {
    examined: inflight.length,
    confirmed: 0,
    failed: 0,
    stillInFlight: 0,
  };
  if (inflight.length === 0) return summary;

  // Head once per pass, and only when something could be judged against it — every intent is
  // compared with the same value, and an idle bot should not poll the chain for nothing.
  const liveness: LivenessCheck = {
    reader,
    now,
    graceMs,
    reclaimMarginBlocks,
    head: reclaimMarginBlocks === undefined ? undefined : await reader.getBlockNumber(),
  };

  // The signer's nonce counts anchor only the nonce-based branches below, all guarded by
  // `nonce !== null`. A keyless MANUAL bot's in-flight intents are operator-broadcast — every one
  // has `nonce === null` — so it would read a signer nonce it does not have, and issue an
  // `eth_getTransactionCount` for nothing. Read lazily: skip both entirely unless some intent
  // actually carries a nonce. (When skipped the values are never consulted — the branches that
  // would are unreachable.)
  const anyNonced = inflight.some((i) => i.nonce !== null);
  const [latest, pending] = anyNonced
    ? await Promise.all([reader.getNonce(signer, "latest"), reader.getNonce(signer, "pending")])
    : [0, 0];

  const nonces = { latest, pending };
  for (const intent of inflight) {
    // Route by what the intent carries: a Safe envelope (MANUAL `safe`), a plain tx hash
    // (AUTO/EOA), or neither (a send whose durable record never completed). `safeEnvelope` is set
    // only by the Safe claim path, so AUTO/EOA intents are never routed through the Safe resolver.
    const resolution = intent.txHash
      ? intent.safeEnvelope
        ? await resolveSafeIntent(reader, signer, intent, intent.txHash, intent.safeEnvelope)
        : await resolveBroadcastIntent(liveness, nonces, intent, intent.txHash)
      : resolveUnbroadcastIntent(liveness, nonces, intent);

    // Bound to the snapshot this pass read: the row may since have advanced, or been revived as a
    // fresh attempt under the same id, and a stale resolution must not land on it.
    if (resolution.status) {
      await store.transition(intent.id, resolution.status, resolution.meta, {
        status: [intent.status],
        ...(intent.txHash ? { txHash: intent.txHash } : {}),
      });
    }
    if (resolution.warn) logger?.warn(resolution.warn);
    summary[resolution.bucket]++;
  }

  logger?.info(
    `Reconcile: ${summary.examined} in-flight → ${summary.confirmed} confirmed, ` +
      `${summary.failed} failed, ${summary.stillInFlight} still in-flight`
  );
  return summary;
}
