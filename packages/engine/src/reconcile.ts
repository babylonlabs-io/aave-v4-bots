import { safeAbi } from "@repo/abis";
import { getNonce, getReceiptStatus, isTxKnown } from "@repo/chain";
import type { Logger } from "@repo/logger";
import type {
  IntentStatus,
  SafeEnvelope,
  StateStore,
  TransitionMeta,
  TxIntent,
} from "@repo/persistence";
import { type Address, type Hex, type PublicClient, parseEventLogs } from "viem";

/**
 * How a `safe`-custody intent's `execTransaction` resolved:
 * - `success` / `failure` — the Safe's matching `Execution{Success,Failure}` event decided it;
 * - `reverted` — the receipt exists but the outer `execTransaction` itself reverted (status 0);
 * - `no-event` — receipt exists, status 1, but no matching Safe event (anomalous);
 * - `null` — no receipt yet.
 */
export type SafeExecutionOutcome = "success" | "failure" | "reverted" | "no-event" | null;

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
   * broadcasting, so a recorded hash proves only that we signed — this distinguishes "in flight"
   * from "signed, but the node rejected the broadcast (e.g. insufficient funds)".
   */
  isKnown(hash: Hex): Promise<boolean>;
  /**
   * Resolve a Safe `execTransaction`: scan `txHash`'s receipt for `safeAddress`'s
   * `Execution{Success,Failure}` event matching `safeTxHash`. See `SafeExecutionOutcome`. Used only
   * for `safe`-custody intents (those carrying a `safeEnvelope`).
   */
  getSafeExecution(
    txHash: Hex,
    safeAddress: Address,
    safeTxHash: Hex
  ): Promise<SafeExecutionOutcome>;
}

/** Bind the `ChainReader` port to a viem `PublicClient`. */
export function createChainReader(publicClient: PublicClient): ChainReader {
  return {
    getReceiptStatus: (hash) => getReceiptStatus(publicClient, hash),
    getNonce: (address, tag) => getNonce(publicClient, address, tag),
    isKnown: (hash) => isTxKnown(publicClient, hash),
    async getSafeExecution(txHash, safeAddress, safeTxHash) {
      // No receipt yet ⇒ not mined ⇒ still in flight. viem throws when the receipt is absent.
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!receipt) return null;
      // The outer execTransaction itself reverted — the SafeTx never ran, nothing is on chain.
      if (receipt.status === "reverted") return "reverted";
      // Match on BOTH the emitting Safe and the SafeTx hash: another contract in the same tx could
      // carry a same-signature event with a coincident bytes32, and must never be mistaken for ours.
      const events = parseEventLogs({
        abi: safeAbi,
        eventName: ["ExecutionSuccess", "ExecutionFailure"],
        logs: receipt.logs,
        strict: false,
      });
      const match = events.find(
        (e) =>
          e.address.toLowerCase() === safeAddress.toLowerCase() &&
          e.args.txHash?.toLowerCase() === safeTxHash.toLowerCase()
      );
      if (!match) return "no-event";
      return match.eventName === "ExecutionSuccess" ? "success" : "failure";
    },
  };
}

export interface ReconcileSummary {
  examined: number;
  confirmed: number;
  failed: number;
  stillInFlight: number;
}

/**
 * How long after its pre-broadcast record a tx the node claims not to know is still treated as
 * possibly in flight.
 *
 * `isKnown` is only as truthful as the endpoint answering it. Behind a load-balanced RPC pool the
 * backend we ask may not be the backend we broadcast to, so a tx that really is on the wire can
 * read as unknown for as long as it takes to propagate. Acting on that immediately is what turns a
 * routing artifact into a double-submitted liquidation, so a `false` only counts once the tx has
 * had time to spread.
 *
 * The cost of the window is bounded and dull: a genuinely rejected broadcast is re-driven one grace
 * period later than it could have been.
 */
export const UNKNOWN_TX_GRACE_MS = 30_000;

/** The clock + tolerance `couldBeInFlight` judges against. */
export interface LivenessCheck {
  reader: ChainReader;
  now: () => number;
  /** Defaults to `UNKNOWN_TX_GRACE_MS`. */
  graceMs?: number;
}

/**
 * Could this signed tx be on the wire right now? The question both `reconcilePending` and the nonce
 * fence must answer the same way — one decides whether to re-drive the action, the other whether to
 * hand its nonce to someone else, and disagreeing would mean re-driving an action whose nonce is
 * still reserved (or the reverse).
 *
 * A tx recorded within the grace window is taken as live without asking: too young for a "no" to
 * mean anything. Past that, the node's answer stands.
 */
export async function couldBeInFlight(
  check: LivenessCheck,
  intent: { txHash: Hex; updatedAt: number }
): Promise<boolean> {
  const graceMs = check.graceMs ?? UNKNOWN_TX_GRACE_MS;
  if (check.now() - intent.updatedAt < graceMs) return true;
  return check.reader.isKnown(intent.txHash);
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
    !(await couldBeInFlight(liveness, { txHash, updatedAt }))
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
  nonces: { latest: number; pending: number },
  intent: TxIntent
): Resolution {
  const { nonce } = intent;
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
  /** Restrict to one action's intents (e.g. `"liquidation"`); omit for all. */
  action?: string;
  logger?: Pick<Logger, "info" | "warn">;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** How long an unknown-to-the-node tx stays presumed-live; defaults to `UNKNOWN_TX_GRACE_MS`. */
  graceMs?: number;
}): Promise<ReconcileSummary> {
  const { store, reader, signer, action, logger, graceMs } = args;
  const now = args.now ?? Date.now;
  const liveness: LivenessCheck = { reader, now, graceMs };
  const inflight = await store.reconcile(action);
  const summary: ReconcileSummary = {
    examined: inflight.length,
    confirmed: 0,
    failed: 0,
    stillInFlight: 0,
  };
  if (inflight.length === 0) return summary;

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
      : resolveUnbroadcastIntent(nonces, intent);

    if (resolution.status) await store.transition(intent.id, resolution.status, resolution.meta);
    if (resolution.warn) logger?.warn(resolution.warn);
    summary[resolution.bucket]++;
  }

  logger?.info(
    `Reconcile: ${summary.examined} in-flight → ${summary.confirmed} confirmed, ` +
      `${summary.failed} failed, ${summary.stillInFlight} still in-flight`
  );
  return summary;
}
