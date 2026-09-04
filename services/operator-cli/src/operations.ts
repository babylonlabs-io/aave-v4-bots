import { safeAbi } from "@repo/abis";
import { findSafeExecutionByHash } from "@repo/chain";
import type { ProposedTx } from "@repo/execution";
import {
  assertZeroGasPolicy,
  computeSafeTxHash,
  decodeExecTransaction,
  hashPayload,
} from "@repo/execution";
import type { SafeEnvelope, StateStore, TxIntent } from "@repo/persistence";
import type { Address, Hex, PublicClient } from "viem";
import type { OperatorSigner } from "./signer";

// The operator-cli command brain — pure orchestration over the store, the signer seam, and chain
// reads, injected via `OperatorContext` so every command is unit-testable without a real chain or
// process. The security-critical checks live here: the inner-hash tamper check, the executor-identity
// check, and (for Safe) the full envelope verification a `confirm` runs against the on-chain tx.

export interface OperatorContext {
  store: StateStore;
  signer: OperatorSigner;
  publicClient: PublicClient;
  /** The identity the proposal was simulated against — an EOA, or the Safe in `safe` custody. */
  executorAddress: Address;
  executorKind: "eoa" | "safe";
  chainId: number;
  now: () => number;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Load one intent by id, or throw an operator-readable error. */
async function load(ctx: OperatorContext, id: string): Promise<TxIntent> {
  const row = await ctx.store.getIntent(id);
  if (!row) throw new Error(`no intent with id ${id}`);
  return row;
}

/**
 * The tamper check: recompute the content hash from the PERSISTED payload and require it to equal the
 * stored `payloadHash`, plus the chain id. Refusing here is the operator's defense against a modified
 * DB row — nothing is ever signed for a payload whose hash does not verify.
 */
export function verifyProposal(
  ctx: OperatorContext,
  row: TxIntent
): { payload: ProposedTx; payloadHash: Hex } {
  if (!row.payload || !row.payloadHash) {
    throw new Error(`intent ${row.id} is not a MANUAL proposal (no payload to sign)`);
  }
  const payload: ProposedTx = row.payload;
  const recomputed = hashPayload(payload);
  if (recomputed !== row.payloadHash) {
    throw new Error(
      `payload hash mismatch for ${row.id}: stored ${row.payloadHash}, recomputed ${recomputed} — refusing (tampered record?)`
    );
  }
  if (payload.chainId !== ctx.chainId) {
    throw new Error(
      `chain mismatch for ${row.id}: payload chainId ${payload.chainId} != configured ${ctx.chainId}`
    );
  }
  return { payload, payloadHash: row.payloadHash };
}

/** The signer must be the identity the proposal was simulated against, or the broadcast diverges. */
function assertSignerIsExecutor(ctx: OperatorContext): void {
  if (!eq(ctx.signer.address, ctx.executorAddress)) {
    throw new Error(
      `signer ${ctx.signer.address} does not match MANUAL_EXECUTOR_ADDRESS ${ctx.executorAddress}`
    );
  }
}

/**
 * The Safe-envelope tamper check: recompute the SafeTx hash from the persisted envelope + payload and
 * require it to equal the stored `safeTxHash`. `payloadHash` covers only the inner call, NOT the
 * envelope, so without this a modified `safeEnvelope.safeTxHash` could be surfaced for an operator to
 * sign (`show`) or matched blindly (`confirm`). Both run it against the same persisted envelope.
 */
function assertSafeEnvelopeIntact(
  ctx: OperatorContext,
  id: string,
  payload: ProposedTx,
  envelope: SafeEnvelope
): void {
  // Policy before consistency, because consistency is the weaker of the two. Both the params and
  // the hash live in one record, so anything that can rewrite it can rewrite both and stay
  // self-consistent — and the refund fields are not covered by `payloadHash` (the inner call only)
  // nor sent out-of-band, so an operator has nothing to compare the displayed hash against. This
  // is the check that does not depend on the record being honest.
  assertZeroGasPolicy(envelope, `intent ${id}`);

  const recomputed = computeSafeTxHash({
    inner: payload,
    params: envelope,
    safe: ctx.executorAddress,
    chainId: ctx.chainId,
  });
  if (recomputed !== envelope.safeTxHash) {
    throw new Error(
      `recomputed safeTxHash ${recomputed} != persisted ${envelope.safeTxHash} for ${id} — refusing (tampered envelope?)`
    );
  }
}

/**
 * Is the claimed envelope still the Safe's *next* transaction? Read from the chain, and the two
 * directions mean opposite things.
 *
 * A nonce **ahead** of the chain is the one thing here a modified record can do and the policy
 * cannot catch: a nonce is not a gas field, so any value is structurally valid, and rewriting it
 * with a recomputed `safeTxHash` leaves the record self-consistent. Everything else an owner signs
 * is pinned — the inner call by `payloadHash`, which the operator compares against the notification,
 * and the gas/refund fields by `assertZeroGasPolicy` — which leaves this as the last field a
 * rewritten row could choose. What it buys is time rather than content: the hash cannot execute now,
 * so the operator signs an authorization that sits valid until the Safe reaches that nonce, for a
 * call they approved at a moment they did not — long enough for an `approve` to be replayed after
 * the revocation that was supposed to end it. A Safe nonce only ever goes up, so this is refused.
 *
 * A nonce **behind** the chain is ordinary history, not a tamper: the SafeTx executed (`confirm` it)
 * or the Safe did something else (`release` it). That is reported rather than refused, so `show`
 * stays a read-only diagnostic in exactly the window an operator reaches for it — after execution,
 * before `confirm`, when the row is still `claimed`. Its hash is no longer signable, and signing it
 * would only produce a signature for a nonce the chain has consumed.
 *
 * Only on the path that surfaces a hash for signing. `confirm`, `release` and the reconcile scan all
 * read envelopes whose nonce the chain has legitimately moved past, and are right to.
 */
async function isEnvelopeNext(
  ctx: OperatorContext,
  id: string,
  envelope: SafeEnvelope
): Promise<boolean> {
  const live = Number(
    await ctx.publicClient.readContract({
      address: ctx.executorAddress,
      abi: safeAbi,
      functionName: "nonce",
    })
  );
  if (live < envelope.safeNonce) {
    throw new Error(
      `Safe nonce for ${id} is ahead of the chain: the envelope reserved ${envelope.safeNonce}, the Safe is at ${live} — refusing to show a hash to sign. A Safe nonce only goes up, so this envelope was changed after the claim.`
    );
  }
  return live === envelope.safeNonce;
}

/**
 * What became of an envelope a previous claim reserved and released without resolving.
 *
 * `release` gives up the claim, not the authorization: a threshold of owners may have signed that
 * SafeTx's hash, off chain where nothing here can see it, and from that moment anyone can execute it
 * until its nonce is consumed. So the record survives the release, and this is what a later claim
 * asks about it before deciding whether it may reserve another.
 *
 * The Safe's nonce is what answers it, and the three cases are not symmetric:
 *
 * - **still at the reserved nonce** — the reservation stands. Re-issuing here would produce the same
 *   hash anyway (the payload and the gas policy are fixed), so there is nothing to decide: the same
 *   envelope is handed back and no second authorization exists.
 * - **past it, and the hash executed** — the action already landed. That is a `confirm`, not a new
 *   attempt, and reserving a second envelope would put the same payload on chain twice.
 * - **past it, and the hash did not execute** — its nonce is spent, so it can never execute. Dead,
 *   and a new envelope may be reserved.
 *
 * A nonce *below* the reservation cannot happen on a chain that only moves forward, so it is refused
 * rather than interpreted.
 */
async function classifyRetainedEnvelope(
  ctx: OperatorContext,
  id: string,
  payload: ProposedTx,
  envelope: SafeEnvelope
): Promise<{ kind: "live" } | { kind: "dead" }> {
  // The hash is about to decide whether a second SafeTx is reserved, so it is checked before it is
  // trusted — the same call `show`, `confirm` and `release` make of the same record.
  assertSafeEnvelopeIntact(ctx, id, payload, envelope);

  const live = Number(
    await ctx.publicClient.readContract({
      address: ctx.executorAddress,
      abi: safeAbi,
      functionName: "nonce",
    })
  );
  if (live < envelope.safeNonce) {
    throw new Error(
      `Safe nonce for ${id} is ahead of the chain: the envelope reserved ${envelope.safeNonce}, the Safe is at ${live} — refusing. A Safe nonce only goes up, so this envelope was changed after the claim.`
    );
  }
  if (live === envelope.safeNonce) return { kind: "live" };

  const executed = await findSafeExecutionByHash(
    ctx.publicClient,
    ctx.executorAddress,
    envelope.safeTxHash,
    BigInt(envelope.claimBlock)
  );
  if (executed) {
    throw new Error(
      `the SafeTx ${envelope.safeTxHash} reserved for ${id} already executed (tx ${executed.txHash}) — record it with \`confirm ${id} --tx ${executed.txHash}\`, not a new claim`
    );
  }
  return { kind: "dead" };
}

/**
 * The envelope a claim should proceed under: the one already outstanding, or a new reservation.
 *
 * Every path that turns a `proposed` row into a `claimed` one goes through here — `claim` and
 * `broadcast` alike — because the thing being protected is not a command, it is the count of
 * executable authorizations over one payload. A second reservation is what makes two of them.
 */
async function envelopeForClaim(
  ctx: OperatorContext,
  id: string,
  row: TxIntent,
  payload: ProposedTx
): Promise<SafeEnvelope | undefined> {
  if (ctx.executorKind !== "safe") return undefined;

  // An envelope on a `proposed` row is one a previous claim reserved and released without resolving.
  const retained = row.safeEnvelope;
  if (retained && (await classifyRetainedEnvelope(ctx, id, payload, retained)).kind === "live") {
    return retained;
  }
  return ctx.signer.buildEnvelope(payload);
}

/**
 * v1 handles ONE Safe SafeTx at a time. Each claim reads `Safe.nonce()` independently, so two
 * concurrent Safe claims would reserve the SAME nonce and one SafeTx would be dead on arrival (it
 * reverts, reconcile fails it, the subject revives — no fund loss, but wasted). Until the store
 * allocates Safe nonces under a lock, refuse a new Safe claim while another Safe intent is still live
 * (`claimed`/`submitted`). No effect on EOA custody.
 */
async function assertNoOtherLiveSafeClaim(ctx: OperatorContext, id: string): Promise<void> {
  if (ctx.executorKind !== "safe") return;
  const live = [...(await ctx.store.proposals()), ...(await ctx.store.reconcile())];
  const other = live.find((r) => r.id !== id && r.safeEnvelope !== null);
  if (other) {
    throw new Error(
      `another Safe intent (${other.id}, ${other.status}) is already in flight — v1 handles one Safe SafeTx at a time; confirm/release/fail it first`
    );
  }
}

/** Proposals awaiting an operator (proposed + claimed), oldest first. */
export function listProposals(ctx: OperatorContext, action?: string): Promise<TxIntent[]> {
  return ctx.store.proposals(action);
}

export interface ProposalView {
  id: string;
  action: string;
  subject: string;
  target: Address;
  status: string;
  payloadHash: Hex;
  call: { to: Address; value: string; data: Hex };
  ageMs: number;
  /** For `safe`: the settled hash (if claimed) or a preview (if still proposed). */
  safeTxHash?: Hex;
  safeTxHashIsPreview?: boolean;
  /** For `safe`: the Safe nonce this hash is for — checked against the chain before it is shown. */
  safeNonce?: number;
  /**
   * For a claimed `safe` row: is this still the Safe's next transaction, and so still signable?
   *
   * `false` means the Safe has moved past it — it executed (`confirm`) or something else did
   * (`release`). A hash ahead of the chain is not reported here; it is refused outright.
   */
  safeTxIsNext?: boolean;
}

/** Verify + render one proposal (read-only). For a not-yet-claimed Safe proposal, previews the
 *  `safeTxHash` the owners would sign (a chain read that allocates no nonce, persists nothing). */
export async function showProposal(ctx: OperatorContext, id: string): Promise<ProposalView> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);

  let safeTxHash = row.safeEnvelope?.safeTxHash;
  let safeTxHashIsPreview = false;
  let safeNonce = row.safeEnvelope?.safeNonce;
  let safeTxIsNext: boolean | undefined;
  if (ctx.executorKind === "safe") {
    if (row.safeEnvelope) {
      // A claimed Safe row: recompute the hash from the persisted envelope and require it to match,
      // so a tampered `safeEnvelope.safeTxHash` can never be shown to an operator to sign.
      assertSafeEnvelopeIntact(ctx, row.id, payload, row.safeEnvelope);
      // Then against the chain, which is the only party to this that a modified record cannot write.
      safeTxIsNext = await isEnvelopeNext(ctx, row.id, row.safeEnvelope);
    } else {
      // Not yet claimed: preview the hash the owners would sign (a chain read, allocates no nonce).
      const preview = await ctx.signer.buildEnvelope(payload);
      safeTxHash = preview?.safeTxHash;
      safeNonce = preview?.safeNonce;
      safeTxHashIsPreview = true;
    }
  }

  return {
    id: row.id,
    action: row.action,
    subject: row.subject,
    target: row.target,
    status: row.status,
    payloadHash,
    call: { to: payload.to, value: payload.value, data: payload.data },
    ageMs: ctx.now() - row.updatedAt,
    safeTxHash,
    safeTxHashIsPreview: safeTxHash ? safeTxHashIsPreview : undefined,
    safeNonce,
    safeTxIsNext,
  };
}

/** Claim a proposal (`proposed → claimed`), fixing the Safe envelope for `safe` custody. The fence:
 *  a superseded/expired proposal fails here, before anything is signed. */
export async function claimProposal(
  ctx: OperatorContext,
  id: string
): Promise<{ claimed: true; row: TxIntent } | { claimed: false; reason: string }> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);
  assertSignerIsExecutor(ctx);
  await assertNoOtherLiveSafeClaim(ctx, id);

  const envelope = await envelopeForClaim(ctx, id, row, payload);
  const result = await ctx.store.claimProposal(id, payloadHash, envelope);
  return result.claimed
    ? { claimed: true, row: result.intent }
    : { claimed: false, reason: result.reason };
}

/** The automatable path: claim → sign + broadcast → record. The `proposed → claimed` CAS is the
 *  broadcast **lease**: only the process that wins it may `send`, so two operators can't both
 *  broadcast the same proposal, and a retried broadcast never double-sends. Returns the tx hash. */
export async function broadcastProposal(
  ctx: OperatorContext,
  id: string
): Promise<{ txHash: Hex }> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);
  assertSignerIsExecutor(ctx);

  // Only a fresh proposal may be broadcast. A row already `claimed` means someone else holds the
  // lease (or a prior attempt sent) — refuse rather than send a second tx; `confirm --tx` records a
  // send that landed, `release` frees an abandoned claim.
  if (row.status !== "proposed") {
    throw new Error(
      `cannot broadcast ${id} in status ${row.status} — only a fresh proposal may be broadcast (use \`confirm --tx\` if it was already sent, else \`release\`)`
    );
  }
  await assertNoOtherLiveSafeClaim(ctx, id);

  // Through the same resolver `claim` uses: this path claims too, so it can strand or duplicate an
  // outstanding reservation in exactly the same way.
  const envelope = await envelopeForClaim(ctx, id, row, payload);
  const result = await ctx.store.claimProposal(id, payloadHash, envelope);
  if (!result.claimed) throw new Error(`cannot claim ${id}: ${result.reason}`);

  const txHash = await ctx.signer.send(payload, result.intent.safeEnvelope ?? undefined);
  const recorded = await ctx.store.markBroadcast(id, txHash, payloadHash);
  if (!recorded) {
    throw new Error(
      `tx ${txHash} was broadcast for ${id} but markBroadcast was refused (state changed) — reconcile with: operator-cli confirm ${id} --tx ${txHash}`
    );
  }
  return { txHash };
}

/**
 * The external-signing report-back (hardware wallet / Safe UI): the operator executed elsewhere, so
 * verify the on-chain tx IS exactly the claimed proposal, then record it. The intended order is
 * `claim → sign externally → confirm`: the claim is the fence (and fixes the Safe envelope a Safe tx
 * is checked against), so `confirm` requires the row to be `claimed` and says so up front.
 */
export async function confirmProposal(
  ctx: OperatorContext,
  id: string,
  txHash: Hex
): Promise<void> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);

  // Surface the claim-first precondition here — before the getTransaction RPC — rather than letting it
  // fail late at markBroadcast's CAS. (markBroadcast still re-checks: this is fail-fast UX, not the guard.)
  if (row.status !== "claimed") {
    throw new Error(
      `confirm requires a claimed proposal (${id} is ${row.status}) — run \`claim ${id}\` first`
    );
  }

  const tx = await ctx.publicClient.getTransaction({ hash: txHash });
  if (ctx.executorKind === "eoa") {
    verifyEoaTx(ctx, payload, tx);
  } else {
    verifySafeTx(ctx, row, payload, tx);
  }

  const recorded = await ctx.store.markBroadcast(id, txHash, payloadHash);
  if (!recorded) {
    throw new Error(
      `markBroadcast refused for ${id} in status ${row.status} — claim it first (operator-cli claim ${id})`
    );
  }
}

/** An EOA broadcast must be the executor calling the target with exactly the payload. */
function verifyEoaTx(
  ctx: OperatorContext,
  payload: ProposedTx,
  tx: { from: Address; to: Address | null; input: Hex; value: bigint }
): void {
  if (!eq(tx.from, ctx.executorAddress)) {
    throw new Error(`tx.from ${tx.from} != executor ${ctx.executorAddress}`);
  }
  if (!tx.to || !eq(tx.to, payload.to))
    throw new Error(`tx.to ${tx.to} != payload.to ${payload.to}`);
  if (!eq(tx.input, payload.data))
    throw new Error("tx calldata does not match the proposal payload");
  if (tx.value !== BigInt(payload.value))
    throw new Error("tx value does not match the proposal payload");
}

/** A Safe broadcast must be an `execTransaction` on the Safe whose decoded inner call + params equal
 *  the payload and the persisted envelope (no unexpected refund/gas). */
function verifySafeTx(
  ctx: OperatorContext,
  row: TxIntent,
  payload: ProposedTx,
  tx: { to: Address | null; input: Hex }
): void {
  if (!tx.to || !eq(tx.to, ctx.executorAddress)) {
    throw new Error(`tx.to ${tx.to} != Safe ${ctx.executorAddress}`);
  }
  const envelope = row.safeEnvelope;
  if (!envelope) throw new Error(`intent ${row.id} has no Safe envelope — claim it first`);

  const decoded = decodeExecTransaction(tx.input);
  if (!eq(decoded.inner.to, payload.to)) throw new Error("execTransaction inner `to` != payload");
  if (!eq(decoded.inner.data, payload.data))
    throw new Error("execTransaction inner calldata != payload");
  if (decoded.inner.value !== payload.value)
    throw new Error("execTransaction inner value != payload");
  // The same policy the envelope is held to, applied to what the chain actually carried. Both are
  // needed and neither implies the other: the hash recompute below hashes the PERSISTED envelope,
  // so a tampered decoded field would not show up there.
  assertZeroGasPolicy(
    { ...decoded.params, safeNonce: envelope.safeNonce },
    `execTransaction for ${row.id}`
  );
  // Finally, the SafeTx must be the exact one we fixed at claim: recompute its hash from the persisted
  // envelope + payload and require it to match what we persisted (the hash owners signed).
  assertSafeEnvelopeIntact(ctx, row.id, payload, envelope);
}

/**
 * Recovery: revert a `claimed` proposal to `proposed` so it can re-notify. For `safe` custody, refuses
 * if OUR exact SafeTx already executed — found by scanning the Safe's `Execution*` events for the
 * reserved `safeTxHash` (precise: an unrelated SafeTx on the same Safe does not trip it, unlike a bare
 * nonce compare). That case is a `confirm`, not a `release`, or a double-broadcast could follow. There
 * is an irreducible window between this read and `store.release` — inherent to any check-then-act
 * against the chain — but under one live claim it only opens if a concurrent process broadcast.
 *
 * What a release does NOT do is retire the SafeTx it scanned for: that authorization lives on the
 * chain's terms, not this row's, and no re-derivation stands between a released row and a second
 * attempt — the row is re-armed carrying the same payload. The envelope is kept for exactly that
 * reason; `classifyRetainedEnvelope` is what the next claim settles it with.
 */
export async function releaseProposal(ctx: OperatorContext, id: string): Promise<void> {
  const row = await load(ctx, id);
  const { payloadHash } = verifyProposal(ctx, row);
  if (row.status !== "claimed") {
    throw new Error(`only a claimed proposal can be released (${id} is ${row.status})`);
  }
  if (ctx.executorKind === "safe" && row.safeEnvelope) {
    const { payload } = verifyProposal(ctx, row);
    // The one path that used to reach for `safeTxHash` without checking the envelope it came from.
    // A hash that does not match its own params is not a thing to scan for — and the same call
    // enforces the zero gas/refund policy, so `release` no longer sees an envelope the other
    // commands would refuse.
    assertSafeEnvelopeIntact(ctx, id, payload, row.safeEnvelope);
    const executed = await findSafeExecutionByHash(
      ctx.publicClient,
      ctx.executorAddress,
      row.safeEnvelope.safeTxHash,
      BigInt(row.safeEnvelope.claimBlock)
    );
    if (executed) {
      throw new Error(
        `the SafeTx ${row.safeEnvelope.safeTxHash} already executed (tx ${executed.txHash}) — record it with \`confirm ${id} --tx ${executed.txHash}\`, not \`release\``
      );
    }
  }
  if (!(await ctx.store.release(id, payloadHash))) {
    throw new Error(`release refused for ${id} (state changed)`);
  }
}

/** Recovery: give up on a wedged intent, reviving its subject for a fresh proposal. Verifies the row
 *  is one of OUR MANUAL proposals (right chain, intact hash) first, so it can't touch an unrelated or
 *  AUTO-side intent that happens to share the store. */
export async function failProposal(
  ctx: OperatorContext,
  id: string,
  reason?: string
): Promise<void> {
  const row = await load(ctx, id);
  const { payload } = verifyProposal(ctx, row);

  // Failing is what strands an authorization: the row goes terminal, and the next proposal for this
  // subject revives it — clearing the envelope, and with it the only record that a signed SafeTx is
  // still executable. So a reservation that still stands is refused here, exactly as a new claim
  // would be. The way out is the chain, not the database: execute it and `confirm`, or let the Safe
  // consume that nonce (its own reject flow does precisely that) and fail it after.
  if (ctx.executorKind === "safe" && row.safeEnvelope) {
    const verdict = await classifyRetainedEnvelope(ctx, id, payload, row.safeEnvelope);
    if (verdict.kind === "live") {
      throw new Error(
        `cannot fail ${id}: the SafeTx ${row.safeEnvelope.safeTxHash} it reserved is still executable at Safe nonce ${row.safeEnvelope.safeNonce}. If owners signed it, it can execute after this row is gone. Execute it and \`confirm\`, or consume that nonce (reject it in the Safe UI), then fail.`
      );
    }
  }

  if (!(await ctx.store.fail(id, reason ?? "failed by operator"))) {
    throw new Error(`fail refused for ${id} (already terminal?)`);
  }
}
