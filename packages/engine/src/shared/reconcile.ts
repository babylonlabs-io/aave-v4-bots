import {
  type BroadcastIntent,
  type IntentStatus,
  type SafeEnvelope,
  type SafeIntent,
  type StateStore,
  type TransitionExpectation,
  type TransitionMeta,
  type TxIntent,
  isBroadcast,
  isSafe,
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
 * How far ahead of this process's clock a row's `updatedAt` may sit before it is worth saying so.
 *
 * `updatedAt` is written from the writer's own `Date.now()` — this bot's, a previous run's on
 * another host, or `operator-cli`'s on a laptop — so every age derived from it is a comparison of
 * two independent wall clocks. A row stamped in the future has a *negative* age, and every guard
 * here asks whether an age is small: an intent being signed right now is protected by a grace
 * window, and one stamped ahead stays inside that window until real time catches up. The subject
 * stays blocked for the whole lead.
 *
 * Twice the grace window, because a lead of the same order as the window itself can at most hold a
 * row for about as long as the window was going to anyway, and a laptop's ordinary drift should not
 * page anyone. Past this the two clocks genuinely disagree, and no age computed from the row means
 * what it says.
 *
 * Deliberately not `MAX_SOURCE_CLOCK_SKEW_MS` from `@repo/risk`: that bounds how far a *chain
 * block's* timestamp may lead ours, where a few seconds is normal and expected. Another machine's
 * clock has no such licence — same shape of problem, different quantity.
 */
export const INTENT_CLOCK_SKEW_WARN_MS = 2 * UNKNOWN_TX_GRACE_MS;

/**
 * Did this SafeTx execute in some *other* transaction than the one we recorded?
 *
 * A SafeTx's calldata carries its owner signatures, so the transaction that executes it need not be
 * the one we know about — a replacement the operator sent, or anyone who copied the calldata. The
 * recorded outer hash is then a hash that will never have a receipt, or one that reverts because the
 * Safe nonce is already spent, while the action itself is on chain.
 *
 * A failed scan is swallowed. It is additive evidence: without it every branch falls back to the
 * answer it gave before this existed, and the alternative is worse — the scan's range grows with the
 * intent's age, so a provider's `eth_getLogs` limit would eventually stop the whole reconcile pass,
 * and one stuck intent would take the bot down with it.
 */
async function findElsewhere(
  liveness: LivenessCheck,
  safe: Address,
  envelope: SafeEnvelope,
  logger?: Pick<Logger, "warn">
): Promise<{ txHash: Hex; success: boolean } | null> {
  try {
    return await liveness.reader.findSafeExecution(safe, envelope.safeTxHash, envelope.claimBlock);
  } catch (error) {
    logger?.warn(
      `Reconcile: could not scan ${safe} for SafeTx ${envelope.safeTxHash} — ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
}

/** Resolve from an `Execution*` event found by scan, recording the hash that actually carried it. */
const resolveFound = (found: { txHash: Hex; success: boolean }): Resolution =>
  found.success
    ? confirmedAs({ txHash: found.txHash })
    : failedAs({ txHash: found.txHash, error: "Safe inner call reverted (ExecutionFailure)" });

/**
 * MANUAL + `safe`: the outer `execTransaction` receipt lies about the inner call (a Safe catches an
 * inner revert and still succeeds), so judge by the Safe's `Execution{Success,Failure}` event — see
 * the ladder in `SafeExecutionOutcome`.
 *
 * Two of those answers are about the recorded transaction rather than the SafeTx, and for those the
 * Safe's own logs get the last word — see `findElsewhere`.
 */
async function resolveSafeIntent(
  liveness: LivenessCheck,
  safe: Address,
  intent: SafeIntent,
  logger?: Pick<Logger, "warn">
): Promise<Resolution> {
  const { txHash, safeEnvelope: envelope } = intent;
  const outcome = await liveness.reader.getSafeExecution(txHash, safe, envelope.safeTxHash);
  switch (outcome) {
    case "success":
      return confirmedAs({ txHash });
    case "failure":
      return failedAs({ txHash, error: "Safe inner call reverted (ExecutionFailure)" });
    case "reverted": {
      // The outer call failed, which is what a transaction executing a SafeTx whose nonce is
      // already spent looks like — so this is the shape of *losing a duplicate*, and the winner
      // carries our action. Nothing is pending here, so there is nothing to wait for before asking.
      const found = await findElsewhere(liveness, safe, envelope, logger);
      if (found) {
        return {
          ...resolveFound(found),
          warn: `Reconcile: ${intent.action} ${intent.subject} — recorded Safe tx ${txHash} reverted, but SafeTx ${envelope.safeTxHash} executed in ${found.txHash}`,
        };
      }
      return failedAs({ txHash, error: "Safe execTransaction reverted" });
    }
    case "no-event":
      // Mined, status 1, yet no matching Execution event — anomalous. Fail (safe: the engine's fresh
      // simulation guards against re-executing an action that did land) and warn loudly, rather than
      // confirm blind or leave it looping forever.
      return {
        ...failedAs({ txHash, error: "Safe tx mined without a matching Execution event" }),
        warn: `Reconcile: ${intent.action} ${intent.subject} — Safe tx ${txHash} carries no Execution event for ${envelope.safeTxHash}`,
      };
    default: {
      // No receipt. Ordinarily that means "not mined yet", and the grace window is there because a
      // young absence means nothing. Past it, an absence that persists is the wedge this scan
      // exists for: the recorded hash may have been replaced, and without asking the Safe directly
      // this intent stays in flight forever — MANUAL intents carry no nonce, so no later transaction
      // will ever move past it and release the subject.
      if (liveness.now() - intent.updatedAt < (liveness.graceMs ?? UNKNOWN_TX_GRACE_MS)) {
        return stillInFlight;
      }
      const found = await findElsewhere(liveness, safe, envelope, logger);
      if (!found) return stillInFlight;
      return {
        ...resolveFound(found),
        warn: `Reconcile: ${intent.action} ${intent.subject} — recorded Safe tx ${txHash} never mined, but SafeTx ${envelope.safeTxHash} executed in ${found.txHash}`,
      };
    }
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
  intent: BroadcastIntent
): Promise<Resolution> {
  const { nonce, updatedAt, txHash } = intent;
  const status = await liveness.reader.getReceiptStatus(txHash);
  if (status === "success") return confirmedAs({ txHash });
  if (status === "reverted") return failedAs({ txHash, error: "reverted (reconciled)" });
  // Everything below reasons from the signer's nonce sequence, so an intent without one — a MANUAL
  // action broadcast from the operator's own wallet — has no further evidence to offer here.
  if (nonce === null) return stillInFlight;
  // No receipt, but the signer's mined nonce has passed this one → the tx was dropped/replaced (or
  // signed-but-never-broadcast and something else took the slot).
  if (nonces.latest > nonce) {
    return failedAs({ txHash, error: "dropped/replaced (reconciled)" });
  }
  // The nonce slot is still free and the node has not heard of this tx for long enough that
  // propagation cannot explain it — so the broadcast was *rejected* (insufficient funds, underpriced,
  // …), not merely unconfirmed. Nothing is on chain, so this is safe to re-drive. Without this an
  // intent would pin live forever: a rejection that blocks one send blocks them all, so no later tx
  // would ever mine past the nonce to release it.
  if (
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
  /**
   * Is this intent one **this process** is sending right now — claimed, not yet resolved?
   *
   * Such an intent is not evidence of anything: the sender holding it is in this address space, so
   * its liveness is known rather than inferred, and every judgement below is inference. Consulted
   * before the resolvers so a row we are actively sending is never read against the chain at all.
   *
   * It is deliberately *not* a substitute for the age checks. Those answer the question this cannot
   * — whether a row belongs to a process that no longer exists — and a restarted bot's set is
   * empty, so nothing here keeps a crash leftover alive.
   */
  isSending?: (id: string) => boolean;
}): Promise<ReconcileSummary> {
  const { store, reader, signer, logger, graceMs, reclaimMarginBlocks, isSending } = args;
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

  /**
   * Bind a transition to the snapshot this pass read: the row may since have advanced, or been
   * revived as a fresh attempt under the same id, and a stale resolution must not land on it.
   *
   * `updatedAt` is what makes that true rather than aspirational. Status and hash cannot tell a
   * revived attempt from the one this pass read — both are `pending` with a null hash — so a
   * resolution decided against a row another engine has since resolved and re-claimed would
   * otherwise fail *its* attempt, mid-signing. The other two stay because they say what the
   * resolution is actually about, and cost nothing.
   *
   * Local because the pairing is this caller's: `recordOutcome` guards a receipt's verdict on the
   * hash alone, deliberately saying nothing about the row's status. What `TransitionExpectation`
   * *means* belongs to the store; which half of it to use is the writer's decision.
   */
  const asRead = (intent: TxIntent): TransitionExpectation => ({
    updatedAt: intent.updatedAt,
    status: [intent.status],
    ...(intent.txHash ? { txHash: intent.txHash } : {}),
  });

  const nonces = { latest, pending };
  for (const intent of inflight) {
    // A send this process is still running. Skipped before anything is read or judged: it is live
    // by construction, and the alternative is failing a sibling engine's claim out from under it
    // while it queues for the shared nonce lock. See `isSending`.
    if (isSending?.(intent.id)) {
      summary.stillInFlight += 1;
      continue;
    }

    // Reported, not acted on. Which answer a disagreeing clock should get is genuinely unknown:
    // holding the row costs its subject the lead, freeing it risks re-driving an action a live
    // process is still signing. So the row is resolved exactly as it would have been, and a human
    // is told the ages behind that decision cannot be trusted.
    const lead = intent.updatedAt - now();
    if (lead > INTENT_CLOCK_SKEW_WARN_MS) {
      logger?.warn(
        `Reconcile: ${intent.action} ${intent.subject} (${intent.id}, ${intent.status}) is stamped ${Math.round(lead / 1000)}s in the future — the clock that wrote it and this one disagree, or the row was altered. Every age judged from it is wrong by that much, and it stays blocked until the lead elapses. Check NTP on every host that writes intents, including wherever operator-cli runs.`
      );
    }

    // Route by what the intent carries: a Safe envelope (MANUAL `safe`), a plain tx hash
    // (AUTO/EOA), or neither (a send whose durable record never completed). `safeEnvelope` is set
    // only by the Safe claim path, so AUTO/EOA intents are never routed through the Safe resolver.
    const resolution = isSafe(intent)
      ? await resolveSafeIntent(liveness, signer, intent, logger)
      : isBroadcast(intent)
        ? await resolveBroadcastIntent(liveness, nonces, intent)
        : resolveUnbroadcastIntent(liveness, nonces, intent);

    if (resolution.status) {
      await store.transition(intent.id, resolution.status, resolution.meta, asRead(intent));
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
