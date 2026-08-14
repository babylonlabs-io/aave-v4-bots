import { erc20Abi } from "@repo/abis";
import { readAllowance } from "@repo/chain";
import type { ProposedTx } from "@repo/execution";
import {
  type ContractCall,
  type ExecutionIdentity,
  type NonceAllocator,
  PreBroadcastError,
  type Submitter,
  type TxSender,
  createNonceAllocator,
  createNonceLease,
  createTxSender,
  encodeCall,
  hashPayload,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { Notifier } from "@repo/notifications";
import type { IntentInput, StateStore, TxIntent } from "@repo/persistence";
import {
  type Address,
  type Chain,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
  maxUint256,
} from "viem";

import { type CrashSafety, createCrashSafety } from "./crashSafety";
import { type ChainReader, createChainReader } from "./liveness";
import { reconcilePending } from "./reconcile";

// The **execution mode seam**. An engine finds opportunities the same way in both modes — risk gate,
// simulation, gas estimate, all keyless reads — and differs only at the moment it commits to acting:
//
//   AUTO   — sign the tx and broadcast it (the bot holds the key).
//   MANUAL — write the tx down for a human to sign, and notify them (the bot holds no key at all).
//
// The engine holds an `Executor` and nothing lower — no `sender`, no `CrashSafety`, and in MANUAL no
// `WalletClient` at all, which is what lets a MANUAL process hold no hot key. `commit` and
// `ensureAllowance` are where the two modes diverge; everything mode-invariant (the risk slot, the
// receipt wait, the poll loop) stays in the engine.

type Hex = `0x${string}`;

/** The outcome of a `commit`: what the engine must do next. */
export type CommitResult =
  /** AUTO — broadcast (or ambiguously so). The engine awaits the receipt and records the outcome. */
  | { kind: "broadcast"; hash: Hex; intentId?: string }
  /** MANUAL — a proposal was written + an operator notified. Nothing is on chain. */
  | { kind: "proposed"; intentId: string }
  /** A live intent for this subject already exists — skip. `existing` is that intent. */
  | { kind: "duplicate"; existing: TxIntent }
  /**
   * AUTO — the send failed. `broadcastAttempted` distinguishes a failed *broadcast* (ambiguous —
   * the tx may be on the wire) from a pre-broadcast failure (nothing reached the chain), so the
   * engine settles the risk slot `abandoned` only for the latter.
   */
  | { kind: "aborted"; broadcastAttempted: boolean; error: string };

/** The only `commit` outcomes `ensureAllowance` can produce for a not-yet-approved allowance. */
export type ProposalResult = Extract<CommitResult, { kind: "proposed" | "duplicate" }>;

/** The result of `ensureAllowance`. `satisfied` = the spender can already pull; otherwise the
 *  allowance is not ready — AUTO throws on a reverted approve (so it never surfaces here), MANUAL
 *  returns `proposed`/`duplicate` (an operator must sign the approval before the dependent action). */
export type AllowanceResult = { kind: "satisfied" } | ProposalResult;

/**
 * The identity of an action to commit — an `IntentInput` minus its `chainId`. The chain is a
 * property of the executor (`identity.chainId`), so the caller never re-specifies it.
 */
export type IntentClaim = Omit<IntentInput, "chainId">;

/** What both executors share — everything that is not about sequencing a signer's nonce. */
interface BaseExecutor {
  /** Who these txs come from (allowance/balance owner, reconcile signer, simulation `from`). */
  readonly identity: ExecutionIdentity;

  /**
   * Resolve this signer's in-flight intents against the chain (in MANUAL, the operator-broadcast
   * ones). Deliberately takes no action filter — see the implementations.
   */
  reconcile(): Promise<void>;
  /** AUTO: reseed the shared nonce lease from the chain. MANUAL: no-op (no nonces). */
  resyncNonces(): Promise<void>;

  /**
   * Commit to acting on `call` under the idempotency `claim`. AUTO: claim → sign+broadcast (under
   * the shared nonce lock) → record. MANUAL: propose (content-hashed payload) → notify. Never both.
   * **Does not settle the risk slot** — the engine owns that on every path, reading the result.
   */
  commit(call: ContractCall, claim: IntentClaim): Promise<CommitResult>;

  /**
   * Record a committed intent's on-chain outcome from the engine's receipt phase. Best-effort and
   * never throws — the chain is the source of truth and reconcile resolves any drift. No-op without
   * a store.
   */
  recordOutcome(
    intentId: string,
    outcome: { kind: "confirmed"; txHash: Hex } | { kind: "failed"; txHash: Hex; error: string }
  ): Promise<void>;

  /**
   * Ensure `identity.from` has approved `spender` to pull at least `required` of `token`. AUTO reads
   * the allowance and, if short, **broadcasts** `approve(spender, maxUint256)` and waits the receipt
   * — today's exact path, key and all, now behind the seam. MANUAL **proposes** the approval instead
   * (an operator must sign it). Returns `satisfied` when the spender can already pull.
   */
  ensureAllowance(input: {
    token: Address;
    spender: Address;
    required: bigint;
    /** For logs (e.g. the token symbol). */
    label?: string;
  }): Promise<AllowanceResult>;
}

/** AUTO — signs and broadcasts. */
export interface AutoExecutor extends BaseExecutor {
  readonly mode: "AUTO";
  /**
   * The account this executor signs with.
   *
   * On the AUTO arm only, because MANUAL has no key at all — so `mode === "AUTO"` is what proves a
   * caller may sign, rather than an optional field and a runtime check. Exposed for the signatures
   * a transaction does not carry: the arbitrage router's EIP-712 authorization is an *argument* to
   * the call `commit` receives, so it has to be produced before there is a transaction to sign.
   * Reading it here rather than injecting an account alongside is what keeps the two the same key.
   */
  readonly account: LocalAccount;
}

/** MANUAL — keyless. No nonce API exists at all: a MANUAL bot never sequences a signer's nonce. */
export interface ManualExecutor extends BaseExecutor {
  readonly mode: "MANUAL";
}

export type Executor = AutoExecutor | ManualExecutor;

/**
 * AUTO executor: signs and broadcasts. Wraps the existing `CrashSafety` (intent idempotency + the
 * shared nonce allocator) and a `TxSender`. `commit` is the engine's former inline claim → send →
 * markPending → submitted block, verbatim in behavior — the regression bar is the existing engine
 * and dual-engine tests passing unchanged.
 */
export function createAutoExecutor(deps: {
  crash: CrashSafety;
  sender: TxSender;
  publicClient: PublicClient;
  /** Holds the key: the AUTO executor signs approvals with it. Never leaves this closure. */
  walletClient: WalletClient<Transport, Chain, LocalAccount>;
  /** Receipt-wait budget for approvals (matches the engine's action timeout). */
  txReceiptTimeoutMs: number;
  /**
   * Private submission only: the block past which the relay can no longer include a transaction,
   * recorded on its intent at submission. Absent under public submission, where the node's own
   * answer about a transaction is authoritative and nothing has to expire.
   */
  horizon?: (hash: Hex) => Promise<number>;
  /**
   * Last word before anything is broadcast: throw to stop it. Supplied by the composition root, and
   * deliberately a bare callback rather than the risk gate — this seam signs and sends, and knows
   * nothing about why an action might be refused.
   *
   * It exists because the gate's state is read once per cycle, when a slot is opened, and a halt
   * can land after that: an operator hitting the kill switch, or a periodic code-hash check finding
   * a target's bytecode changed. Between those two moments this is the only thing left. Approvals
   * go through it too — an approval is a transaction, and the same halt that stops a liquidation
   * has no reason to permit granting an allowance to the contract that caused it.
   *
   * Throw `PreBroadcastError` (the runtime does): the engines already read that as "nothing reached
   * the chain", so the slot settles `abandoned` and the breaker is left alone.
   */
  assertCanBroadcast?: (action: string) => void;
  logger: Logger;
}): AutoExecutor {
  const { crash, sender, publicClient, walletClient, txReceiptTimeoutMs, horizon, logger } = deps;
  const assertCanBroadcast = deps.assertCanBroadcast ?? (() => {});
  const identity = sender.identity;

  /**
   * The horizon to stamp on a submitted intent. Best-effort: a resolver that throws must not turn a
   * landed transaction into an error, and an intent without a horizon is merely fenced by the reader
   * as it was before.
   */
  const horizonFor = async (hash: Hex): Promise<{ relayMaxBlock?: number }> => {
    if (!horizon) return {};
    try {
      return { relayMaxBlock: await horizon(hash) };
    } catch (error) {
      logger.warn(`Could not resolve the relay horizon for ${hash}: ${error}`);
      return {};
    }
  };

  return {
    mode: "AUTO",
    identity,
    account: walletClient.account,

    // Unscoped, as MANUAL is: an intent belongs to the signer, not the engine that created it.
    // Scoping by action strands `approval` — which no engine owns — and a live approval intent
    // makes every later `ensureAllowance` a duplicate.
    reconcile: () => crash.reconcile(),
    resyncNonces: () => crash.resyncNonces(),
    // Guarded on the hash the receipt is for: intent ids are reused when a row is revived, so a late
    // outcome would otherwise stamp the old attempt's verdict onto the new transaction.
    recordOutcome: (id, outcome) =>
      crash.transition(
        id,
        outcome.kind,
        {
          txHash: outcome.txHash,
          ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
        },
        { txHash: outcome.txHash }
      ),

    async ensureAllowance({ token, spender, required, label }) {
      const allowance = await readAllowance(publicClient, token, identity.from, spender);
      if (allowance >= required) return { kind: "satisfied" };

      logger.info(`Approving ${label ?? token} for ${spender}...`);
      // Claimed for nonce safety, not idempotency: `liveNonceFloor` fences by walking persisted
      // intents, so an unclaimed send has nothing fencing it. Invisible under public submission (the
      // node's `pending` count covers it), unsafe under private. Same key MANUAL proposes under.
      const claimed = await crash.claim({
        chainId: identity.chainId,
        target: token,
        action: "approval",
        subject: spender,
      });
      // One is already in flight — this cycle's or a crashed process's. A second would race it on a
      // nonce, so the caller is told the allowance is not ready and retries next cycle.
      if (!claimed.claimed) return { kind: "duplicate", existing: claimed.existing as TxIntent };
      const intentId = claimed.intentId;

      // Through the `TxSender`, not `walletClient.writeContract`: the sender is what carries the
      // submission policy, so an approval must take the same route every other transaction does.
      // Broadcasting it publicly while liquidations went private would put two transactions on one
      // nonce sequence under two different sets of assumptions about who can see them.
      let hash: Hex;
      let signedHash: Hex | undefined;
      try {
        assertCanBroadcast("approval");
        hash = await crash.send((nonce) =>
          sender.send(
            {
              address: token,
              abi: erc20Abi,
              functionName: "approve",
              args: [spender, maxUint256],
              nonce,
            },
            async (signed) => {
              if (intentId && claimed.attemptAt !== undefined) {
                await crash.markPending(intentId, signed.nonce, claimed.attemptAt, signed.hash);
              }
              // Set last: it is what tells the paths below the row under this id is still ours.
              signedHash = signed.hash;
            }
          )
        );
      } catch (error) {
        // Ambiguous — the intent stays LIVE so its nonce keeps its fence and reconcile decides.
        const message = error instanceof Error ? error.message : String(error);
        if (intentId) {
          // Stamp the horizon whenever signing got far enough to produce a hash: an ambiguous send
          // under a fail-closed reader would otherwise fence its nonce with nothing to release it.
          const meta = signedHash ? await horizonFor(signedHash) : {};
          // With no hash the pre-broadcast record never landed, so this may be writing to a row
          // that is no longer this attempt's — bind it to the claim, and let the write be refused
          // if another engine has since resolved and re-claimed the subject. With a hash the row is
          // provably ours (`markPending` proved it) and its stamp has moved on, so nothing to bind.
          await crash.transition(
            intentId,
            "submitted",
            { ...meta, error: message },
            signedHash ? undefined : { updatedAt: claimed.attemptAt }
          );
        }
        throw error;
      }
      if (intentId) {
        await crash.transition(intentId, "submitted", {
          txHash: hash,
          ...(await horizonFor(hash)),
        });
      }

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: txReceiptTimeoutMs,
      });
      if (receipt.status !== "success") {
        if (intentId) {
          await crash.transition(intentId, "failed", { txHash: hash, error: "approval reverted" });
        }
        throw new Error(`Approval transaction reverted for ${label ?? token}`);
      }
      if (intentId) await crash.transition(intentId, "confirmed", { txHash: hash });
      logger.info(`Approved ${label ?? token}`);
      return { kind: "satisfied" };
    },

    async commit(call, claim) {
      const claimed = await crash.claim({ ...claim, chainId: identity.chainId });
      if (!claimed.claimed) return { kind: "duplicate", existing: claimed.existing as TxIntent };
      const intentId = claimed.intentId;

      // Set only once the pre-broadcast record has landed on the attempt we claimed, so it doubles
      // as "this intent is ours to write to". Between the claim and here another engine's reconcile
      // can resolve the row and a later cycle revive it under the same id — `markPending` refuses
      // that, and everything downstream must then keep its hands off the row it now points at.
      let signedHash: Hex | undefined;
      try {
        assertCanBroadcast(claim.action);
        // The reserved nonce arrives here under the allocator's lock. The sender signs it locally
        // first, so `onSigned` durably records nonce + hash before anything reaches the chain.
        const hash = await crash.send((nonce) =>
          sender.send({ ...call, nonce }, async (signed) => {
            if (intentId && claimed.attemptAt !== undefined) {
              await crash.markPending(intentId, signed.nonce, claimed.attemptAt, signed.hash);
            }
            signedHash = signed.hash;
          })
        );
        // The hash was persisted pre-broadcast, so losing this write is safe — except for the
        // horizon, whose absence only means the reader keeps fencing until reconcile stamps one.
        if (intentId) {
          await crash.transition(intentId, "submitted", {
            txHash: hash,
            ...(await horizonFor(hash)),
          });
        }
        return { kind: "broadcast", hash, intentId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Ambiguous — keep the intent LIVE (never terminal); next-cycle reconcile resolves it. The
        // horizon still goes on, so a transaction the relay never forwards can eventually expire.
        if (intentId) {
          const meta = signedHash ? await horizonFor(signedHash) : {};
          // See the approval path: without a durable record this write is bound to the claim, so
          // it lands on our own untouched row and is refused on one that was revived under us.
          await crash.transition(
            intentId,
            "submitted",
            { ...meta, error: message },
            signedHash ? undefined : { updatedAt: claimed.attemptAt }
          );
        }
        return {
          kind: "aborted",
          broadcastAttempted: !(error instanceof PreBroadcastError),
          error: message,
        };
      }
    },
  };
}

/**
 * How this process broadcasts, and how it then judges whether what it broadcast is still live.
 *
 * They travel together because they come from one decision and are only correct together: a private
 * submitter without its matching `reader` leaves the nonce fence interrogating a node that cannot
 * see our transactions, and a fail-closed reader with no recorded horizon never releases a nonce at
 * all. Passing them as one value is what stops a future edit wiring up half of it.
 */
export interface Submission {
  submitter: Submitter;
  reader: ChainReader;
  /** See `CrashSafetyConfig.reclaimMarginBlocks` — with the recorded horizon, what frees a nonce. */
  reclaimMarginBlocks: number;
  /** Stamps each submitted transaction with the block past which it can no longer be included. */
  horizon: (hash: Hex) => Promise<number>;
}

/**
 * The default AUTO executor, built from a wallet: creates the `TxSender` and `CrashSafety` here and
 * wraps them, so callers (the engines' composition and the services) never re-thread that plumbing.
 */
export interface AutoExecutorDeps {
  store?: StateStore;
  /** The shared nonce authority. Omit and a per-signer one is created (single-engine services). */
  nonces?: NonceAllocator;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, LocalAccount>;
  txReceiptTimeoutMs: number;
  logger: Logger;
  /** See `createAutoExecutor`. Omitted ⇒ nothing is refused here. */
  assertCanBroadcast?: (action: string) => void;
  /**
   * Route transactions somewhere other than the node's public mempool. Omitted ⇒ the mempool, which
   * is `createTxSender`'s own default.
   *
   * There is deliberately no way to pass a pre-built `TxSender` here: it would carry its own
   * broadcast route and silently override this one. Callers holding a sender want
   * `createAutoExecutor` (or `./executorTestKit`).
   */
  submission?: Submission;
}

export function createAutoExecutorFromWallet(deps: AutoExecutorDeps): AutoExecutor {
  const { submitter, reader, reclaimMarginBlocks, horizon } = deps.submission ?? {};
  const sender = createTxSender(
    deps.publicClient,
    deps.walletClient,
    submitter?.send.bind(submitter)
  );
  const crash = createCrashSafety({
    store: deps.store,
    reader: reader ?? createChainReader(deps.publicClient),
    reclaimMarginBlocks,
    // The allocator is mandatory (the arbitrageur's two engines share one). A service that runs a
    // single engine off one signer can omit it; we mint a per-signer allocator here.
    nonces: deps.nonces ?? createNonceAllocator(createNonceLease(), sender.identity.from),
    signer: sender.identity.from,
    logger: deps.logger,
  });
  return createAutoExecutor({
    crash,
    sender,
    publicClient: deps.publicClient,
    walletClient: deps.walletClient,
    txReceiptTimeoutMs: deps.txReceiptTimeoutMs,
    horizon,
    assertCanBroadcast: deps.assertCanBroadcast,
    logger: deps.logger,
  });
}

/**
 * MANUAL executor: **keyless**. Persists a content-hashed proposal for an operator to sign, and
 * notifies them. Holds no signer, no nonce, no `TxSender` — `commit` never touches the chain.
 *
 * Dedup with supersede-on-change: a second `commit` for a subject whose live proposal has the *same*
 * payload is a duplicate (no re-notify storm); one whose payload *changed* supersedes the stale
 * proposal and writes a fresh one (the position moved, so the old signable tx is wrong).
 */
export function createManualExecutor(deps: {
  store: StateStore;
  publicClient: PublicClient;
  notifier: Notifier;
  identity: ExecutionIdentity;
  logger: Logger;
  /**
   * Sweep an un-actioned proposal to `expired` after this many ms, each cycle, freeing its subject
   * to be re-proposed (and re-notified). `0` disables the sweep — the "`MANUAL_INTENT_TTL_MS=0`
   * disables expiry" convention lives here: a zero TTL means "never call `expireProposals`", not
   * "expire everything" (`expireProposals(0)` would sweep every live proposal).
   */
  intentTtlMs: number;
  /**
   * Warn (`intent-stuck`) when a `claimed` (operator mid-signing) or `submitted` (broadcast, not yet
   * mined) intent has sat this long — the signal that a claim was abandoned or a tx dropped, which an
   * operator resolves with `confirm`/`release`/`fail`. `0` disables the check.
   */
  intentStuckMs: number;
  /** Injectable clock for the stuck-age check (tests); defaults to `Date.now`. */
  now?: () => number;
}): ManualExecutor {
  const { store, publicClient, notifier, identity, logger, intentTtlMs, intentStuckMs } = deps;
  const now = deps.now ?? Date.now;
  const reader = createChainReader(publicClient);

  // Ids we've already warned as stuck, so a persistently-stuck intent alerts once, not every cycle.
  // Re-derived to the currently-stuck set each cycle: an intent that recovers drops out (and would
  // re-warn if it got stuck again), and the set never grows unbounded.
  let warnedStuck = new Set<string>();

  /** Alert once for each `claimed`/`submitted` intent past `intentStuckMs`. Runs AFTER reconcile, so
   *  an intent resolved this cycle is already gone and never draws a spurious warning. */
  async function emitStuck(): Promise<void> {
    if (intentStuckMs <= 0) return;
    const at = now();
    const candidates = [
      ...(await store.proposals()).filter((r) => r.status === "claimed"),
      ...(await store.reconcile()).filter((r) => r.status === "submitted"),
    ];
    const stuck = new Set<string>();
    for (const intent of candidates) {
      const ageMs = at - intent.updatedAt;
      if (ageMs < intentStuckMs) continue;
      stuck.add(intent.id);
      if (!warnedStuck.has(intent.id)) {
        await notifier.notify({
          kind: "intent-stuck",
          intentId: intent.id,
          subject: intent.subject,
          ageMs,
        });
      }
    }
    warnedStuck = stuck;
  }

  const buildPayload = (call: ContractCall): { payload: ProposedTx; hash: `0x${string}` } => {
    const { to, data } = encodeCall(call);
    const payload: ProposedTx = { chainId: identity.chainId, to, data, value: "0" };
    return { payload, hash: hashPayload(payload) };
  };

  async function announce(intentId: string, claim: IntentInput, hash: `0x${string}`) {
    // The hash travels out-of-band on purpose: it is the operator's tamper check against what
    // `operator-cli` recomputes from the persisted payload. `expiresAt` (when a TTL is set) tells
    // the operator the deadline to sign before `reconcile`'s sweep expires this proposal.
    await notifier.notify({
      kind: "manual-intent",
      intentId,
      action: claim.action,
      subject: claim.subject,
      target: claim.target,
      payloadHash: hash,
      ...(intentTtlMs > 0 ? { expiresAt: Date.now() + intentTtlMs } : {}),
    });
  }

  /** Propose `call` under `claim` (dedup + supersede-on-change), notifying on a fresh proposal. */
  async function propose(call: ContractCall, action: IntentClaim): Promise<ProposalResult> {
    const { payload, hash } = buildPayload(call);
    // The row's chain comes off the payload, not a second read of `identity`: the payload's is the
    // one `hash` commits to and the one the operator broadcasts against, so deriving the key from it
    // is what makes the two agree rather than merely happening to.
    const claim: IntentInput = { ...action, chainId: payload.chainId };

    const recorded = await store.propose(claim, payload, hash);
    if (recorded.recorded) {
      await announce(recorded.id, claim, hash);
      return { kind: "proposed", intentId: recorded.id };
    }

    // A live proposal already exists. If its payload is unchanged, this is a true duplicate. If it
    // changed (the opportunity moved), retire the stale one and propose the fresh tx.
    if (recorded.existing.payloadHash === hash) {
      return { kind: "duplicate", existing: recorded.existing };
    }
    await store.supersede(recorded.existing.id);
    const fresh = await store.propose(claim, payload, hash);
    if (!fresh.recorded) return { kind: "duplicate", existing: fresh.existing };
    await announce(fresh.id, claim, hash);
    return { kind: "proposed", intentId: fresh.id };
  }

  return {
    mode: "MANUAL",
    identity,

    // A keyless bot still reconciles: the operator broadcasts, records the hash (markBroadcast), and
    // the next cycle resolves that intent by receipt/event — with no nonce reads (all intents
    // nonce-less). Everything here works across **all** actions, not just the calling engine's, and
    // deliberately ignores `action`: a keyless MANUAL bot has no per-signer nonce fence that would
    // require scoping, and `approval` proposals belong to no engine's action — so if reconcile were
    // scoped, an operator-broadcast approval would sit `submitted` forever, unconfirmed (which in
    // `safe` custody wedges the one-live-claim guard). Expiry, reconcile, and the stuck sweep all run
    // unscoped; with two engines sharing the store either cycle clears the lot, the other finds none.
    async reconcile() {
      if (intentTtlMs > 0) {
        const swept = await store.expireProposals(intentTtlMs);
        if (swept > 0) logger.info(`Expired ${swept} un-actioned proposal(s)`);
      }
      await reconcilePending({ store, reader, signer: identity.from, logger });
      await emitStuck();
    },
    resyncNonces: () => Promise.resolve(),
    async recordOutcome(id, outcome) {
      // Best-effort, mirroring `CrashSafety.transition`. Rarely reached in MANUAL (proposals resolve
      // via reconcile / markBroadcast, not a receipt phase), but correct when it is.
      try {
        await store.transition(id, outcome.kind, {
          txHash: outcome.txHash,
          ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
        });
      } catch (error) {
        logger.error(`Failed to persist intent ${id} → ${outcome.kind}:`, error);
      }
    },

    commit: (call, claim) => propose(call, claim),

    async ensureAllowance({ token, spender, required }) {
      // Keyless: read the operator's allowance; if short, propose the approval for them to sign.
      // `target` is the token (the contract the `approve` call is sent to, per `IntentInput.target`);
      // `subject` is the spender. Both are in the idempotency key `chainId:target:action:subject`, so
      // two engines approving the SAME token for DIFFERENT spenders never collide into one proposal.
      const allowance = await readAllowance(publicClient, token, identity.from, spender);
      if (allowance >= required) return { kind: "satisfied" };
      return propose(
        { address: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] },
        { target: token, action: "approval", subject: spender }
      );
    },
  };
}
