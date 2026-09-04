import type { ProposedTx } from "@repo/execution";
import {
  buildSafeExecution,
  computeSafeTxHash,
  encodeExecTransaction,
  hashPayload,
} from "@repo/execution";
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

  // The harder tamper, and the one a hash cannot catch. Rewriting the refund fields AND recomputing
  // `safeTxHash` for them leaves the record perfectly self-consistent — the recompute above passes.
  // Nothing else covers those fields: `payloadHash` commits to the inner call, and the notification
  // carries only that, so an operator has no out-of-band value to check the displayed hash against.
  // What catches it is the policy, because a constant in code cannot be rewritten in the database.
  it("refuses an envelope whose refund fields would pay the Safe out, however consistent", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const row = await c.store.getIntent(id);
    if (!row?.safeEnvelope) throw new Error("expected a persisted envelope");
    const drained = {
      ...row.safeEnvelope,
      gasPrice: "1",
      gasToken: "0x3333333333333333333333333333333333333333" as Address,
      refundReceiver: "0x4444444444444444444444444444444444444444" as Address,
    };
    // Recomputed for the tampered params, so params and hash agree with each other.
    const envelope = {
      ...drained,
      safeTxHash: computeSafeTxHash({
        inner: p,
        params: drained,
        safe: SAFE,
        chainId: c.chainId,
      }),
    };
    const tamperedCtx = {
      ...c,
      store: { ...c.store, getIntent: async () => ({ ...row, safeEnvelope: envelope }) },
    };

    await expect(ops.showProposal(tamperedCtx, id)).rejects.toThrow(/gas\/refund/);
  });

  it("names every offending field, so an operator sees what was changed", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const row = await c.store.getIntent(id);
    if (!row?.safeEnvelope) throw new Error("expected a persisted envelope");
    const drained = { ...row.safeEnvelope, gasPrice: "1", baseGas: "21000" };
    const tamperedCtx = {
      ...c,
      store: {
        ...c.store,
        getIntent: async () => ({
          ...row,
          safeEnvelope: {
            ...drained,
            safeTxHash: computeSafeTxHash({
              inner: p,
              params: drained,
              safe: SAFE,
              chainId: c.chainId,
            }),
          },
        }),
      },
    };

    await expect(ops.showProposal(tamperedCtx, id)).rejects.toThrow(/baseGas 21000.*gasPrice 1/);
  });

  // The last field the policy cannot hold: a nonce is not a gas field, so any value is structurally
  // valid, and rewriting it with its hash leaves the record self-consistent like the case above. It
  // does not change what executes — it changes WHEN, to a moment the operator never approved. The
  // chain is the one party to this that a modified record cannot write.
  it("refuses an envelope moved to a future nonce, however consistent", async () => {
    const c = ctx({
      signer: safeSigner(4),
      executorAddress: SAFE,
      executorKind: "safe",
      publicClient: fakeClient({ safeNonce: 4n }),
    });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const row = await c.store.getIntent(id);
    if (!row?.safeEnvelope) throw new Error("expected a persisted envelope");
    const future = { ...row.safeEnvelope, safeNonce: 5 };
    const envelope = {
      ...future,
      safeTxHash: computeSafeTxHash({ inner: p, params: future, safe: SAFE, chainId: c.chainId }),
    };
    const tamperedCtx = {
      ...c,
      store: { ...c.store, getIntent: async () => ({ ...row, safeEnvelope: envelope }) },
    };

    await expect(ops.showProposal(tamperedCtx, id)).rejects.toThrow(/ahead of the chain/);
  });

  // The other direction, and not a tamper at all: the SafeTx executed, or the Safe did something
  // else. It is reported rather than refused — this is the window an operator runs `show` in, after
  // execution and before `confirm`, and a diagnostic that throws there tells them nothing.
  it("reports, without refusing, a claim the Safe has already moved past", async () => {
    const c = ctx({
      signer: safeSigner(4),
      executorAddress: SAFE,
      executorKind: "safe",
      publicClient: fakeClient({ safeNonce: 4n }),
    });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const moved = { ...c, publicClient: fakeClient({ safeNonce: 5n }) };
    const view = await ops.showProposal(moved, id);

    expect(view.safeTxIsNext).toBe(false);
    expect(view.safeNonce).toBe(4);
  });

  it("shows the hash and its nonce when the envelope is the Safe's next transaction", async () => {
    const c = ctx({
      signer: safeSigner(4),
      executorAddress: SAFE,
      executorKind: "safe",
      publicClient: fakeClient({ safeNonce: 4n }),
    });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const view = await ops.showProposal(c, id);

    // The nonce travels with the hash: it is what an operator can check against the Safe UI.
    expect(view.safeNonce).toBe(4);
    expect(view.safeTxIsNext).toBe(true);
    expect(view.safeTxHash).toBe((await c.store.getIntent(id))?.safeEnvelope?.safeTxHash);
    expect(view.safeTxHashIsPreview).toBe(false);
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

  // `claimBlock` is a height read from one endpoint at claim time. A reorg, or a `getLogs` endpoint
  // trailing the one that recorded it, puts the execution just BELOW it — and starting the scan
  // exactly there reports a landed SafeTx as never executed. Release then frees the claim, the
  // subject is re-proposed, and an owner signs the same fund-moving action again under a fresh
  // nonce. The scan therefore begins below the anchor, not at it.
  it("release refuses when the SafeTx executed just below the recorded claim height", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const env = (await c.store.getIntent(id))?.safeEnvelope;
    if (!env) throw new Error("expected an envelope");
    // The claim recorded block 100; the execution is visible only from block 95 onward.
    c.publicClient = {
      getBlockNumber: async () => 200n,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
        fromBlock <= 95n
          ? [
              {
                eventName: "ExecutionSuccess",
                args: { txHash: env.safeTxHash },
                transactionHash: SENT_TX,
              },
            ]
          : [],
    } as unknown as PublicClient;

    await expect(ops.releaseProposal(c, id)).rejects.toThrow(/already executed/);
    expect((await c.store.getIntent(id))?.status).toBe("claimed");
  });

  // `release` used to be the one path that read `safeTxHash` without checking the envelope it came
  // from — so it would scan for, and act on, a hash the other commands would refuse outright.
  it("release refuses an envelope whose refund fields would pay the Safe out", async () => {
    const c = ctx({ signer: safeSigner(), executorAddress: SAFE, executorKind: "safe" });
    const p = payload();
    const id = idempotencyKey(input());
    await c.store.propose(input(), p, hashPayload(p));
    await ops.claimProposal(c, id);

    const row = await c.store.getIntent(id);
    if (!row?.safeEnvelope) throw new Error("expected an envelope");
    const drained = { ...row.safeEnvelope, gasPrice: "1" };
    const tampered = {
      ...row,
      safeEnvelope: {
        ...drained,
        safeTxHash: computeSafeTxHash({ inner: p, params: drained, safe: SAFE, chainId: CHAIN }),
      },
    };

    await expect(
      ops.releaseProposal({ ...c, store: { ...c.store, getIntent: async () => tampered } }, id)
    ).rejects.toThrow(/gas\/refund/);
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

  // The gap release leaves behind, and the reason the envelope now survives it. Owners sign the hash
  // off chain, where nothing here can see it, and from that moment anyone can execute that SafeTx
  // until its nonce is consumed. Reserving a second envelope over the same payload is what turns
  // that into two executions.
  describe("an envelope released without being resolved", () => {
    const safeCtx = (safeNonce = 4, over: Parameters<typeof fakeClient>[0] = {}) =>
      ctx({
        signer: safeSigner(safeNonce),
        executorAddress: SAFE,
        executorKind: "safe",
        publicClient: fakeClient({ safeNonce: BigInt(safeNonce), ...over }),
      });

    const claimedThenReleased = async (c: ops.OperatorContext) => {
      const p = payload();
      const id = idempotencyKey(input());
      await c.store.propose(input(), p, hashPayload(p));
      await ops.claimProposal(c, id);
      const envelope = (await c.store.getIntent(id))?.safeEnvelope;
      if (!envelope) throw new Error("expected an envelope");
      await ops.releaseProposal(c, id);
      return { id, envelope };
    };

    it("survives the release rather than being discarded", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      const row = await c.store.getIntent(id);
      expect(row?.status).toBe("proposed");
      expect(row?.safeEnvelope).toEqual(envelope);
    });

    // Nothing to decide: the payload and the gas policy are fixed, so a re-claim at the same nonce
    // computes the very hash that is already outstanding. Handing it back is what keeps the count of
    // executable authorizations at one.
    it("is handed back by the next claim while its nonce still stands", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      const result = await ops.claimProposal(c, id);

      expect(result.claimed).toBe(true);
      expect((await c.store.getIntent(id))?.safeEnvelope).toEqual(envelope);
    });

    // The sequence this exists for: released, executed by anyone watching the queue, then claimed
    // again. A second envelope here is the same payload authorized twice.
    it("refuses the next claim when it executed after the release", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      // The Safe moved on, and it moved on by executing exactly our SafeTx.
      c.publicClient = fakeClient({
        safeNonce: 5n,
        safeLogs: [
          {
            eventName: "ExecutionSuccess",
            args: { txHash: envelope.safeTxHash },
            transactionHash: SENT_TX,
          },
        ],
      });

      await expect(ops.claimProposal(c, id)).rejects.toThrow(/already executed/);
    });

    // Its nonce is spent by something else, so it can never execute. Dead, and the way is clear.
    it("is replaced once its nonce is spent by another transaction", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      c.publicClient = fakeClient({ safeNonce: 5n });
      c.signer = safeSigner(5);

      const result = await ops.claimProposal(c, id);

      expect(result.claimed).toBe(true);
      const replaced = (await c.store.getIntent(id))?.safeEnvelope;
      expect(replaced?.safeNonce).toBe(5);
      expect(replaced?.safeTxHash).not.toBe(envelope.safeTxHash);
    });

    // `broadcast` claims too, so it can duplicate a reservation exactly as `claim` can — and it
    // sends what it reserves, which makes it the worse of the two paths to leave open.
    it("is handed back by broadcast rather than reserved a second time", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      await ops.broadcastProposal(c, id);

      expect((await c.store.getIntent(id))?.safeEnvelope).toEqual(envelope);
    });

    it("refuses a broadcast when it executed after the release", async () => {
      const c = safeCtx();
      const { id, envelope } = await claimedThenReleased(c);

      c.publicClient = fakeClient({
        safeNonce: 5n,
        safeLogs: [
          {
            eventName: "ExecutionSuccess",
            args: { txHash: envelope.safeTxHash },
            transactionHash: SENT_TX,
          },
        ],
      });

      await expect(ops.broadcastProposal(c, id)).rejects.toThrow(/already executed/);
    });

    // `fail` is what strands it: the row goes terminal and the next proposal for the subject revives
    // it, clearing the envelope and with it the only record of what is still outstanding.
    it("cannot be failed away while it still stands", async () => {
      const c = safeCtx();
      const { id } = await claimedThenReleased(c);

      await expect(ops.failProposal(c, id)).rejects.toThrow(/still executable/);
      expect((await c.store.getIntent(id))?.status).toBe("proposed");
    });

    it("can be failed once its nonce is spent and it did not execute", async () => {
      const c = safeCtx();
      const { id } = await claimedThenReleased(c);

      c.publicClient = fakeClient({ safeNonce: 5n });

      await ops.failProposal(c, id, "giving up");
      expect((await c.store.getIntent(id))?.status).toBe("failed");
    });
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
