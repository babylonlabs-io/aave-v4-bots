import { safeAbi } from "@repo/abis";
import {
  type ProposalPayload,
  computeSafeTxHash,
  decodeExecTransaction,
  hashPayload,
} from "@repo/execution";
import type { StateStore, TxIntent } from "@repo/persistence";
import { type Address, type Hex, type PublicClient, getAddress } from "viem";
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

const ZERO = "0x0000000000000000000000000000000000000000";
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
): { payload: ProposalPayload; payloadHash: Hex } {
  if (!row.payload || !row.payloadHash) {
    throw new Error(`intent ${row.id} is not a MANUAL proposal (no payload to sign)`);
  }
  const payload = row.payload as ProposalPayload;
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
}

/** Verify + render one proposal (read-only). For a not-yet-claimed Safe proposal, previews the
 *  `safeTxHash` the owners would sign (a chain read that allocates no nonce, persists nothing). */
export async function showProposal(ctx: OperatorContext, id: string): Promise<ProposalView> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);

  let safeTxHash = row.safeEnvelope?.safeTxHash;
  let safeTxHashIsPreview = false;
  if (ctx.executorKind === "safe" && !safeTxHash) {
    const preview = await ctx.signer.buildEnvelope(payload);
    safeTxHash = preview?.safeTxHash;
    safeTxHashIsPreview = true;
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

  const envelope =
    ctx.executorKind === "safe" ? await ctx.signer.buildEnvelope(payload) : undefined;
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

  const envelope =
    ctx.executorKind === "safe" ? await ctx.signer.buildEnvelope(payload) : undefined;
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
 * verify the on-chain tx IS exactly the claimed proposal, then record it. Requires the row to be
 * `claimed` already (its envelope is what a Safe tx is checked against).
 */
export async function confirmProposal(
  ctx: OperatorContext,
  id: string,
  txHash: Hex
): Promise<void> {
  const row = await load(ctx, id);
  const { payload, payloadHash } = verifyProposal(ctx, row);

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
  payload: ProposalPayload,
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
  payload: ProposalPayload,
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
  if (decoded.params.operation !== 0) throw new Error("execTransaction operation is not CALL");
  // v1 policy: every gas/refund field zero. `gasPrice`/`gasToken`/`refundReceiver` nonzero would drain
  // the Safe; `safeTxGas`/`baseGas` are checked too, else a tampered value slips past — the hash
  // recompute below hashes the persisted envelope, not these decoded fields, so it would not catch it.
  if (
    decoded.params.safeTxGas !== "0" ||
    decoded.params.baseGas !== "0" ||
    decoded.params.gasPrice !== "0" ||
    !eq(decoded.params.gasToken, ZERO) ||
    !eq(decoded.params.refundReceiver, ZERO)
  ) {
    throw new Error("execTransaction carries nonzero gas/refund fields — refusing");
  }
  // Finally, the SafeTx must be the exact one we fixed at claim: recompute its hash from the envelope
  // and payload and require it to match what we persisted (the hash owners signed).
  const recomputed = computeSafeTxHash({
    inner: payload,
    params: envelope,
    safe: ctx.executorAddress,
    chainId: ctx.chainId,
  });
  if (recomputed !== envelope.safeTxHash) {
    throw new Error(`recomputed safeTxHash ${recomputed} != persisted ${envelope.safeTxHash}`);
  }
}

/**
 * Recovery: revert a `claimed` proposal to `proposed` so it can re-notify. Refuses if the SafeTx may
 * already have executed (the Safe's on-chain nonce advanced past the reserved one) — that case is a
 * `confirm`, not a `release`, or a double-broadcast could follow.
 */
export async function releaseProposal(ctx: OperatorContext, id: string): Promise<void> {
  const row = await load(ctx, id);
  const { payloadHash } = verifyProposal(ctx, row);
  if (row.status !== "claimed") {
    throw new Error(`only a claimed proposal can be released (${id} is ${row.status})`);
  }
  if (ctx.executorKind === "safe" && row.safeEnvelope) {
    const current = await ctx.publicClient.readContract({
      address: ctx.executorAddress,
      abi: safeAbi,
      functionName: "nonce",
    });
    if (Number(current) > row.safeEnvelope.safeNonce) {
      throw new Error(
        `Safe nonce (${current}) has passed the reserved ${row.safeEnvelope.safeNonce} — the SafeTx may have executed; use \`confirm --tx\` instead`
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
  verifyProposal(ctx, await load(ctx, id));
  if (!(await ctx.store.fail(id, reason ?? "failed by operator"))) {
    throw new Error(`fail refused for ${id} (already terminal?)`);
  }
}
