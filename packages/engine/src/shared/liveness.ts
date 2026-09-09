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
   * Blocks past a transaction's recorded relay horizon before its nonce is released, regardless of
   * what the reader says. Unset ⇒ no release, which is right for public submission: a public
   * transaction can linger in a node's pool indefinitely and the node's own answer is authoritative.
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
 * mean anything. Past that the reader's answer stands, until the chain passes the tx's own recorded
 * relay horizon — beyond which it is declared gone whatever the reader claims. See
 * `reclaimMarginBlocks` for why that backstop exists.
 */
export async function couldBeInFlight(
  check: LivenessCheck,
  intent: { txHash: Hex; updatedAt: number; relayMaxBlock?: number | null }
): Promise<boolean> {
  const age = check.now() - intent.updatedAt;
  if (age < (check.graceMs ?? UNKNOWN_TX_GRACE_MS)) return true;
  // Past the relay's own deadline for this transaction (plus reorg headroom) it can no longer be
  // included, so nothing the reader says should keep its nonce.
  if (
    check.reclaimMarginBlocks !== undefined &&
    check.head !== undefined &&
    intent.relayMaxBlock != null &&
    check.head > intent.relayMaxBlock + check.reclaimMarginBlocks
  ) {
    return false;
  }
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
 * Hard ceiling on a relay-declared deadline, independent of anything the operator configured.
 *
 * Absolute rather than a multiple of the configured window, because the two errors it sits between
 * are not symmetric. Believing an over-long declaration fences a nonce for longer than it needed to
 * be: the bot stops trading and an operator can see exactly why. Recording one *shorter* than the
 * relay's real deadline hands out a nonce the relay can still spend, which is the failure this
 * mechanism exists to prevent. A cap derived from the configured window would shrink along with it,
 * so declaring a short window would truncate the relay's own honest, longer answer.
 *
 * Roughly a day of Ethereum blocks, matching the ceiling the config puts on the declared window.
 */
export const MAX_RELAY_HORIZON_BLOCKS = 7200;

/**
 * Resolve a just-submitted transaction's deadline — the block past which it can no longer be
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
    // Never shorter than either input: the cap only trims a declaration that is implausible on its
    // face, and the configured window is a floor rather than a competing answer. A relay that
    // reports a longer deadline than we expected is telling us something we cannot learn any other
    // way, and the safe reading of a disagreement here is always the later block.
    //
    // A relay that says nothing reports 0 — see `flashbots.ts`. The fallback carries it then, and
    // is the only bound in that case, which is why the configured window has to describe the real
    // relay rather than however long the operator would like to wait.
    return Math.max(clampDeclared(status?.maxBlockNumber ?? 0, head, hash, logger), fallback);
  }

  /**
   * Recover the horizon of an already-submitted transaction whose own submission never recorded one —
   * the write is best-effort (`horizonFor` in `./executor`), so a failed head read or a crash between
   * the pre-broadcast record and the horizon write leaves a row carrying a nonce and a hash but no
   * deadline. Nothing else ever fills that column, and `couldBeInFlight` cannot release without it, so
   * such a row fences its nonce forever and every later send queues behind the gap.
   *
   * `null` means **do not repair** — keep fencing, and try again next pass. Every branch that cannot
   * *prove* the deadline it would record resolves that way, because the cost of the two mistakes is
   * not symmetric: fencing longer than needed costs throughput an operator can see, while recording a
   * deadline shorter than the relay's real one hands out a nonce the relay can still spend.
   *
   * Unlike `createRelayHorizon` this never falls back to the configured window. That fallback is only
   * sound at submission, where the transaction is known to be ours, freshly sent, and sent *privately*.
   * At repair time none of the three is given:
   *
   * - A `null` horizon is also what an ordinary **public** submission leaves behind (see
   *   `TxIntent.relayMaxBlock`), and `reclaimMarginBlocks` describes the process reading the row, not
   *   the process that wrote it. A bot restarted into private submission would otherwise stamp a relay
   *   deadline onto a public transaction, and then release its nonce while it still sat in the public
   *   mempool — where a transaction may legitimately linger forever. A relay that has never received
   *   a hash answers `UNKNOWN`, so requiring a positive answer is what proves the row is ours *and*
   *   private.
   * - `UNKNOWN` is equally the answer for a hash the relay has simply forgotten. Recording the
   *   configured window then would overwrite a real, longer, no-longer-observable deadline with a
   *   short guess — the one direction this must never move in.
   * - A declaration of `0` means the relay is holding the transaction but naming no deadline
   *   (`flashbots.ts`), which is no more evidence than `UNKNOWN` is.
   *
   * So the only horizon this records is the relay's own, for that exact hash. A probe that throws
   * propagates: the caller warns and leaves the row fenced.
   */
  async function repair(hash: Hex): Promise<number | null> {
    const status = await relay.status(hash);
    // Never received, or no longer held — either way the relay is not evidence of a deadline.
    if (status.status === "UNKNOWN") return null;
    // The relay is holding it, but it is also in the public mempool, so the relay's deadline does
    // not bound when it can be included. A public transaction outlives any horizon we could record.
    if (status.seenInMempool) return null;
    // Held, but with no deadline of its own to report.
    if (status.maxBlockNumber <= 0) return null;
    return clampDeclared(status.maxBlockNumber, await node.getBlockNumber(), hash, logger);
  }
}

/**
 * A relay route's two answers about one transaction's deadline: the block past which the relay can
 * no longer include it, which is the only thing that releases a privately-submitted nonce.
 *
 * One port rather than two functions because they are only correct as a pair, and because both must
 * be backed by the *same* relay. `repair` proves a row is ours-and-private by asking the relay
 * whether it holds the hash, so a `repair` pointed at a different relay than the one `resolve`
 * submitted through would be answering about a transaction that relay never saw. Building both from
 * one adapter is what makes that unwireable.
 *
 * Consumers narrow to the half they use — `Pick<Horizon, "repair">` and so on — the same way they
 * narrow `Logger`.
 */
export interface Horizon {
  /**
   * The deadline to record at submission, for a transaction we know we just sent privately. Falls
   * back to the configured window when the relay declares nothing; see `createRelayHorizon`.
   */
  resolve(hash: Hex): Promise<number>;
  /**
   * The deadline to record at reconcile, for an already-submitted row whose own horizon write never
   * landed. `null` means the relay cannot vouch for the hash, so nothing is recorded and the row
   * stays fenced. Never falls back to the configured window — see `createRelayHorizon`.
   */
  repair(hash: Hex): Promise<number | null>;
}

/**
 * Trim a relay's declared deadline to `MAX_RELAY_HORIZON_BLOCKS` past `head`, saying so when it
 * bites. Shared by the submission-time resolver and the reconcile-time repair so one cap governs
 * every horizon this bot will ever record.
 */
function clampDeclared(
  declared: number,
  head: number,
  hash: Hex,
  logger?: Pick<Logger, "warn">
): number {
  const ceiling = head + MAX_RELAY_HORIZON_BLOCKS;
  if (declared > ceiling) {
    // Said rather than silently clamped: a relay naming a deadline a day out is either broken or
    // not the relay we think we are talking to, and the operator cannot infer either from a nonce
    // that simply takes longer to come back.
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
