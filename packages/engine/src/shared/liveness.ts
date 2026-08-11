import { safeAbi } from "@repo/abis";
import { getNonce, getReceiptStatus, isTxKnown } from "@repo/chain";
import type { RelayTxStatus } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type Address, type Hex, type PublicClient, parseEventLogs } from "viem";

/**
 * How a `safe`-custody intent's `execTransaction` resolved:
 * - `success` / `failure` — the Safe's matching `Execution{Success,Failure}` event decided it;
 * - `reverted` — the receipt exists but the outer `execTransaction` itself reverted (status 0);
 * - `no-event` — receipt exists, status 1, but no matching Safe event (anomalous);
 * - `null` — no receipt yet.
 */
export type SafeExecutionOutcome = "success" | "failure" | "reverted" | "no-event" | null;

/**
 * The chain reads this engine needs, declared by the consumers that need them — `couldBeInFlight`
 * below, the nonce fence in `./crashSafety`, and `./reconcile`.
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
  /**
   * Upper bound on how long a recorded tx may hold its nonce, regardless of what the reader says.
   * Unset ⇒ no bound, which is right for public submission: a public tx can linger in some node's
   * pool indefinitely, and the node's own answer is authoritative.
   *
   * Private submission needs the bound, because there the reader deliberately fails closed — an
   * unreachable relay, or a hash it has forgotten, both read as "still in flight". Without a clock
   * that always advances, a single dropped transaction would fence its nonce forever and every
   * later send would queue behind the gap: not a degraded bot, a dead one. Set it past the relay's
   * own retry horizon so it can only fire once the transaction can no longer be included.
   */
  maxFenceMs?: number;
}

/**
 * Could this signed tx be on the wire right now? The question both `reconcilePending` and the nonce
 * fence must answer the same way — one decides whether to re-drive the action, the other whether to
 * hand its nonce to someone else, and disagreeing would mean re-driving an action whose nonce is
 * still reserved (or the reverse).
 *
 * A tx recorded within the grace window is taken as live without asking: too young for a "no" to
 * mean anything. Past that, the reader's answer stands — until `maxFenceMs`, beyond which the tx is
 * declared gone whatever the reader claims. See `maxFenceMs` for why that backstop exists.
 */
export async function couldBeInFlight(
  check: LivenessCheck,
  intent: { txHash: Hex; updatedAt: number }
): Promise<boolean> {
  const age = check.now() - intent.updatedAt;
  if (age < (check.graceMs ?? UNKNOWN_TX_GRACE_MS)) return true;
  if (check.maxFenceMs !== undefined && age > check.maxFenceMs) return false;
  return check.reader.isKnown(intent.txHash);
}

// ── Private submission ──────────────────────────────────────────────────────────────────────
//
// Under private submission the node-backed answer above is wrong by construction: the transaction
// was never offered to the public mempool, so our node has never heard of it. Left uncorrected both
// consumers act on that "no" — the fence drops below a nonce the relay may still include, and
// reconcile marks a genuinely pending liquidation `failed`, freeing its subject to be re-driven
// while the first is still live. The reader below wraps the node's so a transaction the relay is
// still holding reads as live.

/** The subset of the relay adapter this needs — injected so tests script it without a network. */
export interface RelayStatusSource {
  status(hash: Hex): Promise<RelayTxStatus>;
}

/**
 * Wrap `node` so a transaction the relay still holds counts as in flight.
 *
 * **Fails closed, and that is the whole point.** A status probe that throws — Flashbots down, a
 * 429, a network blip — reports the transaction as *live*, never as gone. Both consumers treat
 * "live" as the cautious answer: the fence keeps the nonce reserved, and reconcile leaves the intent
 * alone. The opposite choice would turn a relay outage into nonce reuse.
 *
 * It also keeps the relay off the bot's critical path. `BaseEngine.run()` calls `reconcile()` before
 * anything else in the cycle, so letting a probe failure propagate would mean a Flashbots outage
 * stops the bot from trading at all, rather than merely from reclaiming nonces.
 */
export function createRelayAwareReader(
  node: ChainReader,
  relay: RelayStatusSource,
  logger: Logger,
  /** Every status observed, plus `sim_error` and `probe_error`. Injected, not a metrics dependency. */
  onStatus: (status: string) => void = () => {}
): ChainReader {
  return {
    ...node,
    async isKnown(hash) {
      // Ask the node first: once a private transaction mines it is ordinary chain state, and that
      // answer costs nothing extra when it is already yes.
      if (await node.isKnown(hash)) return true;
      try {
        // Every status the relay can return fences, including terminal ones. Releasing on a status
        // would put a third party's field in charge of nonce safety, and `UNKNOWN` cannot be told
        // apart from "expired from the index" — so a transaction the relay merely forgot would free
        // a nonce that might still be spent. `LivenessCheck.maxFenceMs` is what releases instead:
        // a clock that always advances, set past the relay's own retry horizon.
        //
        // The call is still made because a reachable relay is the signal worth logging and, later,
        // reporting: `simError` means our transaction is defective rather than out-competed.
        const { status, simError } = await relay.status(hash);
        onStatus(status);
        if (simError) {
          onStatus("sim_error");
          logger.warn(`Relay reports ${hash} unviable (${simError}) — status ${status}`);
        }
        return true;
      } catch (error) {
        onStatus("probe_error");
        logger.warn(
          `Relay status probe failed for ${hash} — treating it as in flight, so its nonce stays fenced: ${error}`
        );
        return true;
      }
    },
  };
}
