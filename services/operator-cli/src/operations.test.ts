import type { ProposedTx } from "@repo/execution";
import { buildSafeExecution, encodeExecTransaction, hashPayload } from "@repo/execution";
import { type IntentInput, createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import * as ops from "./operations";
import type { OperatorSigner } from "./signer";

const EXECUTOR = "0x1111111111111111111111111111111111111111" as Address;
const SAFE = "0x2222222222222222222222222222222222222222" as Address;
const TARGET = "0x3333333333333333333333333333333333333333" as Address;
const OTHER = "0x4444444444444444444444444444444444444444" as Address;
const SENT_TX = `0x${"c".repeat(64)}` as Hex;
const CHAIN = 31337;

const input = (subject = "p"): IntentInput => ({
  chainId: CHAIN,
  target: TARGET,
  action: "liquidation",
  subject,
});
const payload = (over: Partial<ProposedTx> = {}): ProposedTx => ({
  chainId: CHAIN,
  to: TARGET,
  data: "0xdeadbeef",
  value: "0",
  ...over,
});

const eoaSigner = (address: Address = EXECUTOR): OperatorSigner => ({
  address,
  buildEnvelope: async () => undefined,
  send: async () => SENT_TX,
});
const safeSigner = (safeNonce = 4): OperatorSigner => ({
  address: SAFE,
  buildEnvelope: async (inner) => ({
    ...buildSafeExecution({ inner, safe: SAFE, chainId: CHAIN, safeNonce, safeVersion: "1.4.1" }),
    claimBlock: 100,
  }),
  send: async () => SENT_TX,
});

const fakeClient = (
  over: { tx?: unknown; safeNonce?: bigint; safeLogs?: unknown[]; blockNumber?: bigint } = {}
): PublicClient =>
  ({
    getTransaction: async () => over.tx,
    readContract: async () => over.safeNonce ?? 0n,
    getBlockNumber: async () => over.blockNumber ?? 0n,
    getLogs: async () => over.safeLogs ?? [],
  }) as unknown as PublicClient;

function ctx(over: Partial<ops.OperatorContext> = {}): ops.OperatorContext {
  return {
    store: createMemoryStateStore(),
    signer: eoaSigner(),
    publicClient: fakeClient(),
    executorAddress: EXECUTOR,
    executorKind: "eoa",
    chainId: CHAIN,
    now: () => 1_000_000,
    ...over,
  };
}

describe("verifyProposal (tamper check)", () => {
  it("passes for a payload whose hash matches", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    const view = await ops.showProposal(c, idempotencyKey(input()));
    expect(view.call).toEqual({ to: TARGET, value: "0", data: p.data });
  });

  it("refuses a payload whose stored hash does not match (tampered record)", async () => {
    const c = ctx();
    await c.store.propose(input(), payload(), `0x${"e".repeat(64)}` as Hex);
    await expect(ops.showProposal(c, idempotencyKey(input()))).rejects.toThrow(/hash mismatch/);
  });

  // Injected rather than proposed: the store refuses to write a payload whose chain disagrees with
  // its intent, so the only way this row exists is a rewritten record — with a hash that recomputes
  // cleanly, so the chain check is the sole thing standing between the operator and signing for the
  // wrong chain.
  it("refuses a payload for a different chain", async () => {
    const c = ctx();
    const p = payload({ chainId: 999 });
    const id = idempotencyKey(input());
    await c.store.propose(input(), payload(), hashPayload(payload()));
    const row = await c.store.getIntent(id);
    const tampered = { ...row, payload: p, payloadHash: hashPayload(p) } as NonNullable<typeof row>;
    const tamperedCtx = { ...c, store: { ...c.store, getIntent: async () => tampered } };

    await expect(ops.showProposal(tamperedCtx, id)).rejects.toThrow(/chain mismatch/);
  });

  it("refuses a claimed Safe row whose stored safeTxHash was tampered", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    // Tamper ONLY the stored safeTxHash — payload + payloadHash stay intact, so `verifyProposal`
    // passes; the recompute in `show` is the only thing that catches it.
    const row = await c.store.getIntent(id);
    if (!row?.safeEnvelope) throw new Error("expected a persisted envelope");
    const tampered = {
      ...row,
      safeEnvelope: { ...row.safeEnvelope, safeTxHash: `0x${"b".repeat(64)}` as Hex },
    };
    const tamperedCtx = { ...c, store: { ...c.store, getIntent: async () => tampered } };
    await expect(ops.showProposal(tamperedCtx, id)).rejects.toThrow(/tampered envelope/);
  });
});

describe("claimProposal", () => {
  it("claims a proposed intent", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    const result = await ops.claimProposal(c, idempotencyKey(input()));
    expect(result.claimed).toBe(true);
    expect((await c.store.getIntent(idempotencyKey(input())))?.status).toBe("claimed");
  });

  it("refuses a superseded proposal (the fence)", async () => {
    const c = ctx();
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await c.store.supersede(id);
    const result = await ops.claimProposal(c, id);
    expect(result).toMatchObject({ claimed: false, reason: "not-proposed" });
  });

  it("persists the Safe envelope in safe custody", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    const row = await c.store.getIntent(idempotencyKey(input()));
    expect(row?.safeEnvelope?.safeNonce).toBe(4);
    expect(row?.safeEnvelope?.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("broadcastProposal", () => {
  it("eoa: claims, sends, and records the tx", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    const { txHash } = await ops.broadcastProposal(c, idempotencyKey(input()));
    expect(txHash).toBe(SENT_TX);
    expect(await c.store.getIntent(idempotencyKey(input()))).toMatchObject({
      status: "submitted",
      txHash: SENT_TX,
    });
  });

  it("refuses a superseded proposal — nothing is sent", async () => {
    const c = ctx();
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await c.store.supersede(id);
    await expect(ops.broadcastProposal(c, id)).rejects.toThrow(/superseded/);
  });

  it("safe: builds the envelope, sends, and records", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.broadcastProposal(c, idempotencyKey(input()));
    expect(await c.store.getIntent(idempotencyKey(input()))).toMatchObject({
      status: "submitted",
      txHash: SENT_TX,
    });
  });

  it("refuses a row already claimed — the claim is the lease, so no second send", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input())); // someone else holds the claim
    await expect(ops.broadcastProposal(c, idempotencyKey(input()))).rejects.toThrow(
      /only a fresh proposal/
    );
  });

  it("safe: refuses a second concurrent claim (the nonce would collide)", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const pa = payload();
    await c.store.propose(input("a"), pa, hashPayload(pa));
    await ops.claimProposal(c, idempotencyKey(input("a"))); // one live Safe claim
    const pb = payload();
    await c.store.propose(input("b"), pb, hashPayload(pb));
    await expect(ops.broadcastProposal(c, idempotencyKey(input("b")))).rejects.toThrow(
      /one Safe SafeTx at a time/
    );
  });
});

describe("confirmProposal (external report-back)", () => {
  const eoaTx = (over: Record<string, unknown> = {}) => ({
    from: EXECUTOR,
    to: TARGET,
    input: "0xdeadbeef",
    value: 0n,
    ...over,
  });

  async function claimedEoa() {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    return c;
  }

  it("records an EOA tx that matches the proposal", async () => {
    const c = await claimedEoa();
    c.publicClient = fakeClient({ tx: eoaTx() });
    await ops.confirmProposal(c, idempotencyKey(input()), SENT_TX);
    expect(await c.store.getIntent(idempotencyKey(input()))).toMatchObject({
      status: "submitted",
      txHash: SENT_TX,
    });
  });

  it("rejects an EOA tx from a different sender", async () => {
    const c = await claimedEoa();
    c.publicClient = fakeClient({ tx: eoaTx({ from: OTHER }) });
    await expect(ops.confirmProposal(c, idempotencyKey(input()), SENT_TX)).rejects.toThrow(/from/);
  });

  it("rejects an EOA tx with different calldata", async () => {
    const c = await claimedEoa();
    c.publicClient = fakeClient({ tx: eoaTx({ input: "0xbadbad" }) });
    await expect(ops.confirmProposal(c, idempotencyKey(input()), SENT_TX)).rejects.toThrow(
      /calldata/
    );
  });

  it("refuses (fail-fast) when the proposal was never claimed", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p)); // proposed, not claimed
    // No tx set on the client: the claim-first guard must fire BEFORE the getTransaction RPC.
    await expect(ops.confirmProposal(c, idempotencyKey(input()), SENT_TX)).rejects.toThrow(
      /requires a claimed proposal/
    );
  });

  it("records a Safe execTransaction whose decoded inner call + envelope match", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    const envelope = (await c.store.getIntent(idempotencyKey(input())))?.safeEnvelope;
    if (!envelope) throw new Error("expected an envelope");

    const execData = encodeExecTransaction({ inner: p, params: envelope, signatures: "0x" });
    c.publicClient = fakeClient({ tx: { to: SAFE, input: execData } });

    await ops.confirmProposal(c, idempotencyKey(input()), SENT_TX);
    expect((await c.store.getIntent(idempotencyKey(input())))?.status).toBe("submitted");
  });

  it("rejects a Safe execTransaction that carries a nonzero refund receiver", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    const envelope = (await c.store.getIntent(idempotencyKey(input())))?.safeEnvelope;
    if (!envelope) throw new Error("expected an envelope");

    const tampered = encodeExecTransaction({
      inner: p,
      params: { ...envelope, refundReceiver: OTHER },
      signatures: "0x",
    });
    c.publicClient = fakeClient({ tx: { to: SAFE, input: tampered } });

    await expect(ops.confirmProposal(c, idempotencyKey(input()), SENT_TX)).rejects.toThrow(
      /refund/
    );
  });

  it("rejects a Safe execTransaction with a tampered safeTxGas", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    const envelope = (await c.store.getIntent(idempotencyKey(input())))?.safeEnvelope;
    if (!envelope) throw new Error("expected an envelope");

    const tampered = encodeExecTransaction({
      inner: p,
      params: { ...envelope, safeTxGas: "50000" },
      signatures: "0x",
    });
    c.publicClient = fakeClient({ tx: { to: SAFE, input: tampered } });

    await expect(ops.confirmProposal(c, idempotencyKey(input()), SENT_TX)).rejects.toThrow(
      /gas\/refund/
    );
  });
});

describe("release + fail (recovery)", () => {
  it("release reverts a claimed proposal to proposed", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, idempotencyKey(input()));
    await ops.releaseProposal(c, idempotencyKey(input()));
    expect((await c.store.getIntent(idempotencyKey(input())))?.status).toBe("proposed");
  });

  it("release refuses a Safe claim whose exact SafeTx already executed", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    // The Safe emitted an Execution event carrying OUR reserved safeTxHash → it landed; release must
    // refuse and point at `confirm`.
    const env = (await c.store.getIntent(id))?.safeEnvelope;
    if (!env) throw new Error("expected an envelope");
    c.publicClient = fakeClient({
      safeLogs: [
        {
          eventName: "ExecutionSuccess",
          args: { txHash: env.safeTxHash },
          transactionHash: SENT_TX,
        },
      ],
    });
    await expect(ops.releaseProposal(c, id)).rejects.toThrow(/already executed/);
    expect((await c.store.getIntent(id))?.status).toBe("claimed"); // untouched
  });

  it("release proceeds when only an UNRELATED SafeTx advanced the Safe (no matching hash)", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    // An Execution event exists, but for a DIFFERENT safeTxHash — ours never ran, so release applies.
    c.publicClient = fakeClient({
      safeLogs: [
        {
          eventName: "ExecutionSuccess",
          args: { txHash: `0x${"9".repeat(64)}` },
          transactionHash: SENT_TX,
        },
      ],
    });
    await ops.releaseProposal(c, id);
    expect((await c.store.getIntent(id))?.status).toBe("proposed");
  });

  it("fail marks a proposal failed and revives the subject", async () => {
    const c = ctx();
    const p = payload();
    await c.store.propose(input(), p, hashPayload(p));
    await ops.failProposal(c, idempotencyKey(input()), "giving up");
    expect(await c.store.getIntent(idempotencyKey(input()))).toMatchObject({
      status: "failed",
      error: "giving up",
    });
  });

  it("fail refuses a row that is not one of our MANUAL proposals (e.g. an AUTO intent)", async () => {
    const c = ctx();
    await c.store.recordIntent(input()); // AUTO `pending`, no payload
    await expect(ops.failProposal(c, idempotencyKey(input()))).rejects.toThrow(
      /not a MANUAL proposal/
    );
  });
});
