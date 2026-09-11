import { safeAbi } from "@repo/abis";
import { findSafeExecutionByHash, getNonce, getReceiptStatus, isTxKnown } from "@repo/chain";
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
  /** Current chain head — what a recorded relay horizon is compared against. */
  getBlockNumber(): Promise<number>;
  /**
   * Does the node know this tx at all (mempool **or** mined)? Senders record the hash before
   * broadcasting, so a recorded hash proves only that we signed — this distinguishes "in flight"
   * from "signed, but the node rejected the broadcast (e.g. insufficient funds)".
   */
  isKnown(hash: Hex): Promise<boolean>;
  /**
   * Node knowledge alone, for a reader whose `isKnown` also counts relay knowledge. Absent ⇒
   * `isKnown` is already node knowledge. See `couldBeInFlight`.
   */
  isKnownToNode?(hash: Hex): Promise<boolean>;
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
  /**
   * Has this exact SafeTx executed *in any transaction*, and in which one? Scans `safeAddress`'s
   * `Execution{Success,Failure}` events from `anchor` (the claim-time height) for `safeTxHash`.
   *
   * The counterpart to `getSafeExecution`, which can only answer for a transaction hash we recorded.
   * A SafeTx's calldata carries its owner signatures, so the transaction that executes it need not
   * be the one we know about: a replacement, or anyone who copied the calldata, executes the same
   * SafeTx under a different hash. Matching by `safeTxHash` rather than the Safe's nonce is what
   * keeps this precise on a Safe with other traffic.
   */
  findSafeExecution(
    safeAddress: Address,
    safeTxHash: Hex,
    anchor: number
  ): Promise<{ txHash: Hex; success: boolean } | null>;
}

/** Bind the `ChainReader` port to a viem `PublicClient`. */
export function createChainReader(publicClient: PublicClient): ChainReader {
  return {
    getReceiptStatus: (hash) => getReceiptStatus(publicClient, hash),
    getNonce: (address, tag) => getNonce(publicClient, address, tag),
    getBlockNumber: async () => Number(await publicClient.getBlockNumber()),
    isKnown: (hash) => isTxKnown(publicClient, hash),
    findSafeExecution: (safeAddress, safeTxHash, anchor) =>
      findSafeExecutionByHash(publicClient, safeAddress, safeTxHash, BigInt(anchor)),
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
   * Blocks past a transaction's recorded relay horizon before relay knowledge stops keeping it in
   * flight; after that only the node's own knowledge counts. Unset ⇒ the reader always decides,
   * which is right for public submission: a public transaction can linger in a node's pool
   * indefinitely and the node's own answer is authoritative.
   *
   * Private submission needs it, because there the reader deliberately fails closed — an unreachable
   * relay, or a hash it has forgotten, both read as "still in flight". Without something that always
   * advances, one dropped transaction fences its nonce forever and every later send queues behind
   * the gap. Block height rather than elapsed time because the horizon it is measured against is the
   * relay's own, denominated in blocks; a duration has to be guessed against that, and guessing low
   * frees a nonce the relay may still spend.
   */
  reclaimMarginBlocks?: number;
  /** Chain head, read once per pass by the caller rather than per intent. */
  head?: number;
}

/**
 * Could this signed tx be on the wire right now? The question both `reconcilePending` and the nonce
 * fence must answer the same way — one decides whether to re-drive the action, the other whether to
 * hand its nonce to someone else, and disagreeing would mean re-driving an action whose nonce is
 * still reserved (or the reverse).
 *
 * A tx recorded within the grace window is taken as live without asking: too young for a "no" to
 * mean anything. Past that the reader's answer stands until the chain passes the tx's recorded
 * relay horizon. Beyond it only the node's knowledge counts: the relay can no longer include the
 * tx, but a copy in the node's pool still can. See `reclaimMarginBlocks`.
 */
export async function couldBeInFlight(
  check: LivenessCheck,
  intent: { txHash: Hex; updatedAt: number; relayMaxBlock?: number | null }
): Promise<boolean> {
  const age = check.now() - intent.updatedAt;
  if (age < (check.graceMs ?? UNKNOWN_TX_GRACE_MS)) return true;
  // Past the relay's deadline the relay can no longer include it, so only the node's answer
  // counts: a copy in its pool (leaked, or reinserted by a reorg) still can.
  if (pastRelayHorizon(check, intent.relayMaxBlock)) {
    return knownToNode(check.reader, intent.txHash);
  }
  return check.reader.isKnown(intent.txHash);
}

/** Is the chain past this transaction's relay deadline plus the reorg margin? */
function pastRelayHorizon(check: LivenessCheck, relayMaxBlock?: number | null): boolean {
  const { head, reclaimMarginBlocks: margin } = check;
  if (head === undefined || margin === undefined || relayMaxBlock == null) return false;
  return head > relayMaxBlock + margin;
}

/** The node's own answer. A reader without `isKnownToNode` already answers from the node. */
function knownToNode(reader: ChainReader, hash: Hex): Promise<boolean> {
  return reader.isKnownToNode ? reader.isKnownToNode(hash) : reader.isKnown(hash);
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
 * Maximum relay-declared deadline, in blocks past head (about one day). Independent of the
 * configured window, so a short window never truncates a relay's longer deadline.
 */
export const MAX_RELAY_HORIZON_BLOCKS = 7200;

/**
 * Build a relay's `Horizon`.
 *
 * `resolve`: a just-submitted transaction's deadline — the block past which it can no longer be
 * included, recorded on its intent so the nonce fence has something that always advances. The later
 * of the relay's own `maxBlockNumber` and `head + horizonBlocks`.
 *
 * The relay's value is the real one — the block after which it stops offering the transaction to
 * builders — and asking for it is why the horizon is not a constant copied from docs. It is not
 * trusted to *shorten* the fence, though: a status probe right after submission can legitimately
 * answer `UNKNOWN` (not indexed yet) or fail outright, and a relay under-reporting its own window
 * would free a nonce it may still spend. So the declared window is a floor, and every uncertainty
 * here resolves toward fencing longer.
 */
export function createRelayHorizon(
  node: ChainReader,
  relay: RelayStatusSource,
  horizonBlocks: number,
  logger?: Pick<Logger, "warn">
): Horizon {
  return { resolve, repair };

  async function resolve(hash: Hex): Promise<number> {
    const [head, status] = await Promise.all([
      node.getBlockNumber(),
      relay.status(hash).catch(() => null),
    ]);
    const fallback = head + horizonBlocks;
    // The later of the relay's deadline and the configured window. A relay that declares nothing
    // reports 0, so the window alone bounds it and must match the relay's real window.
    return Math.max(clampDeclared(status?.maxBlockNumber ?? 0, head, hash, logger), fallback);
  }

  /**
   * Recover the deadline of a submitted row whose horizon write never landed (`horizonFor` is
   * best-effort). Without it, `couldBeInFlight` never releases the row's nonce.
   *
   * Returns only the relay's own deadline for this hash, or `null` (keep fencing) when:
   * - the status is `UNKNOWN`: the relay never received the hash, as with a public submission,
   *   or no longer remembers it and its deadline;
   * - `seenInMempool` is set: the transaction is public, so no relay deadline bounds it;
   * - `maxBlockNumber` is 0: the relay names no deadline.
   * A failed probe throws; the caller keeps the row fenced.
   */
  async function repair(hash: Hex): Promise<number | null> {
    const status = await relay.status(hash);
    if (status.status === "UNKNOWN") return null;
    if (status.seenInMempool) return null;
    if (status.maxBlockNumber <= 0) return null;
    return clampDeclared(status.maxBlockNumber, await node.getBlockNumber(), hash, logger);
  }
}

/**
 * A private transaction's deadline: the last block the relay can include it in. Past it, the
 * nonce is released unless the node holds the transaction. Both methods use one relay, because `repair` proves a row went through it.
 */
export interface Horizon {
  /** Deadline to record at submission. Falls back to the configured window. */
  resolve(hash: Hex): Promise<number>;
  /** Deadline to recover at reconcile for a row that has none. `null`: keep the row fenced. */
  repair(hash: Hex): Promise<number | null>;
}

/** Cap a relay-declared deadline at `MAX_RELAY_HORIZON_BLOCKS` past `head`, and warn when it applies. */
function clampDeclared(
  declared: number,
  head: number,
  hash: Hex,
  logger?: Pick<Logger, "warn">
): number {
  const ceiling = head + MAX_RELAY_HORIZON_BLOCKS;
  if (declared > ceiling) {
    // A deadline a day out means a broken or unexpected relay. The operator must see it.
    logger?.warn(
      `Relay declared a deadline of block ${declared} for ${hash}, beyond the ${MAX_RELAY_HORIZON_BLOCKS} blocks this bot will fence for — fencing to ${ceiling} instead.`
    );
  }
  return Math.min(declared, ceiling);
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
    isKnownToNode: (hash) => node.isKnown(hash),
    async isKnown(hash) {
      // Ask the node first: once a private transaction mines it is ordinary chain state, and that
      // answer costs nothing extra when it is already yes.
      if (await node.isKnown(hash)) return true;
      try {
        // Every status the relay can return fences, including terminal ones. Releasing on a status
        // would put a third party's field in charge of nonce safety, and `UNKNOWN` cannot be told
        // apart from "expired from the index" — so a transaction the relay merely forgot would free
        // a nonce that might still be spent. The horizon recorded at submission is what releases
        // instead: the relay's own deadline for that one transaction, measured in blocks.
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
