import {
  type NonceAllocator,
  type RelayTxStatus,
  createNonceAllocator,
  createNonceLease,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import { createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import { type Address, type Hex, type PublicClient, TransactionNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";

import { type CrashSafetyConfig, createCrashSafety } from "./crashSafety";
import {
  type ChainReader,
  UNKNOWN_TX_GRACE_MS,
  createChainReader,
  createRelayAwareReader,
} from "./liveness";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const HASH = "0xhash" as Hex;

const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const input = (subject: string) => ({
  chainId: 31337,
  target: TARGET,
  action: "liquidation",
  subject,
});

const publicClient = { getTransactionCount: vi.fn(async () => 7) } as unknown as PublicClient;

/** An allocator that hands out `nonce` and records the region held under its lock. */
const allocator = (nonce: number): NonceAllocator => ({
  withNonce: (send) => send(nonce),
  resync: vi.fn(async () => {}),
});

const crash = (over: Partial<CrashSafetyConfig> = {}) =>
  createCrashSafety({
    reader: createChainReader(publicClient),
    signer: SIGNER,
    logger: silentLogger,
    nonces: allocator(0),
    ...over,
  });

describe("createCrashSafety", () => {
  describe("send", () => {
    it("passes the allocator's reserved nonce to the callback", async () => {
      const seen: number[] = [];
      await crash({ nonces: allocator(5) }).send(async (n) => {
        seen.push(n);
        return HASH;
      });
      expect(seen).toEqual([5]);
    });

    it("propagates a send error (an ambiguous broadcast must not be swallowed)", async () => {
      await expect(
        crash({ nonces: allocator(3) }).send(async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
    });
  });

  describe("markPending vs transition — the throw/swallow split", () => {
    // Pre-broadcast: if the reserved nonce cannot be recorded we must NOT broadcast against it.
    it("markPending propagates a store failure", async () => {
      const store = createMemoryStateStore();
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("db down"));
      await expect(crash({ store }).markPending("id", 4, 1)).rejects.toThrow("db down");
    });

    // Post-broadcast: the tx is on chain. A bookkeeping failure is logged; reconcile fixes drift.
    it("transition swallows a store failure and logs it", async () => {
      const store = createMemoryStateStore();
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("db down"));
      const logger = { ...silentLogger, error: vi.fn() };

      await expect(crash({ store, logger }).transition("id", "confirmed")).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it("both no-op without a store", async () => {
      await expect(crash().markPending("id", 4, 1)).resolves.toBeUndefined();
      await expect(crash().transition("id", "confirmed")).resolves.toBeUndefined();
    });

    // The pre-broadcast record is a compare-and-set against the attempt this send claimed, and
    // `markPending` throwing is the ONLY thing that can call off a broadcast: `TxSender` aborts on
    // an `onSigned` that throws, and nothing else between signing and the wire looks at the row.
    // So a lost CAS must not be recoverable-looking — an applied-anyway write would resurrect a row
    // somebody else resolved and put a transaction on chain against their decision, and the record
    // would read `pending → submitted` with no trace that anything was refused.
    it("refuses to broadcast, and leaves the row alone, when the attempt it claimed was resolved", async () => {
      let clock = 1_700_000_000_000;
      const store = createMemoryStateStore(() => {
        clock += 1_000;
        return clock;
      });
      const cs = crash({ store });
      const { intentId, attemptAt } = await cs.claim(input("p"));
      if (!intentId || attemptAt === undefined) throw new Error("expected a claimed intent");

      // Resolved terminally while the signer was busy — a reconcile verdict, or an operator.
      expect(await store.fail(intentId, "given up on")).toBe(true);

      await expect(cs.markPending(intentId, 4, attemptAt, HASH)).rejects.toThrow(
        /no longer the attempt this send claimed/
      );

      // Not resurrected: the terminal decision stands, and this send's nonce and hash are not
      // recorded against it.
      expect(await store.getIntent(intentId)).toMatchObject({
        status: "failed",
        nonce: null,
        txHash: null,
      });
    });
  });

  // The arbitrageur runs both engines off ONE executor, so one `CrashSafety` — and a claim is taken
  // *before* the send queues for the shared nonce lock. A slow relay ahead of it in that queue is
  // charged against the intent's age, so the sibling engine's reconcile can find a row that is
  // seconds from broadcast and older than the grace window. Nothing unsafe follows (`markPending`
  // refuses the resurrected row), but a ready action is thrown away for nothing.
  describe("reconcile and a send this process is still running", () => {
    const held = async () => {
      let clock = 1_700_000_000_000;
      const store = createMemoryStateStore(() => clock);
      const cs = crash({ store, now: () => clock });
      const { intentId } = await cs.claim(input("p"));
      if (!intentId) throw new Error("expected a claimed intent");
      cs.beginSend(intentId);
      // Far past any grace window: the point is that duration is not what decides this.
      clock += 10 * 60_000;
      return {
        cs,
        store,
        intentId,
        advance: () => {
          clock += 60_000;
        },
      };
    };

    it("leaves it alone however long the send has taken", async () => {
      const { cs, store, intentId } = await held();

      await cs.reconcile();

      expect(await store.getIntent(intentId)).toMatchObject({
        status: "pending",
        nonce: null,
        txHash: null,
      });
    });

    // The other half, and the reason this is a held-claim set rather than a longer window: the age
    // check still has to resolve the row a *dead* process left behind, which is the same row. A
    // restarted bot holds no claims, so its set is empty and this is exactly what it sees.
    it("resolves the same row once nothing is holding it", async () => {
      const { cs, store, intentId, advance } = await held();
      cs.endSend(intentId);
      advance();

      await cs.reconcile();

      expect(await store.getIntent(intentId)).toMatchObject({
        status: "failed",
        error: "not broadcast (reconciled)",
      });
    });

    it("endSend is idempotent and tolerates an id that was never begun", async () => {
      const { cs, intentId } = await held();
      expect(() => {
        cs.endSend(intentId);
        cs.endSend(intentId);
        cs.endSend("never-begun");
      }).not.toThrow();
    });
  });

  describe("claim", () => {
    it("claims a fresh subject and returns its intent id", async () => {
      const store = createMemoryStateStore();
      const result = await crash({ store }).claim(input("p"));

      expect(result).toEqual({
        claimed: true,
        intentId: idempotencyKey(input("p")),
        // The version token that tells this attempt from the next revival of the same id.
        attemptAt: expect.any(Number),
      });
    });

    // Claim does NOT settle the slot — settling exposure is the engine's job on every path. On
    // refusal it hands back the live intent so the caller can settle `abandoned` and report it.
    it("refuses a duplicate live intent and returns the existing one, settling nothing", async () => {
      const store = createMemoryStateStore();
      const cs = crash({ store });
      await cs.claim(input("p"));

      const result = await cs.claim(input("p"));
      expect(result.claimed).toBe(false);
      expect(result.existing).toMatchObject({ subject: "p", status: "pending" });
    });

    it("without a store, always claims and never yields an intent id", async () => {
      expect(await crash().claim(input("p"))).toEqual({ claimed: true });
    });
  });

  describe("reconcile / resyncNonces", () => {
    it("reconcile no-ops without a store", async () => {
      await expect(crash().reconcile()).resolves.toBeUndefined();
    });

    it("resyncNonces re-seeds the allocator from the chain's pending count", async () => {
      const nonces = allocator(1);
      await crash({ nonces }).resyncNonces();
      expect(nonces.resync).toHaveBeenCalledOnce();
    });
  });

  // Two properties that must hold together. `resync` re-seeds the lease from the chain's `pending`
  // count and may move it *down*, reclaiming a nonce we reserved but never broadcast; the fence
  // bounds how far down, so the lease never lands on a nonce a live tx already holds (signing over
  // it would replace a liquidation on the wire). `pending` alone cannot decide this — a provider
  // that never surfaces its mempool reports N while our tx sits at N — so `isKnown` separates the
  // two: senders record nonce + hash BEFORE broadcasting, meaning a recorded hash proves only that
  // we signed.
  describe("resyncNonces — the live-tx fence", () => {
    /** A chain whose `pending` count is `pending` and which knows the txs in `known`. */
    const chain = (pending: number, known: Hex[]) =>
      ({
        getTransactionCount: vi.fn(async () => pending),
        getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
          if (!known.includes(hash)) throw new TransactionNotFoundError({ hash });
          return { hash };
        }),
      }) as unknown as PublicClient;

    /**
     * Seed a live intent at `nonce`/`txHash`, then resync, and report the next nonce handed out.
     * `ageMs` is how old the intent's pre-broadcast record appears — past the grace window an
     * "unknown to the node" answer is trusted, inside it the tx is presumed still propagating.
     */
    async function nextNonceAfterResync(args: {
      publicClient: PublicClient;
      nonce: number;
      txHash?: Hex;
      action?: string;
      ageMs?: number;
    }) {
      const store = createMemoryStateStore();
      const intent = { ...input("pos-1"), action: args.action ?? "liquidation" };
      await store.recordIntent(intent);
      await store.transition(idempotencyKey(intent), "submitted", {
        nonce: args.nonce,
        ...(args.txHash ? { txHash: args.txHash } : {}),
      });

      const ageMs = args.ageMs ?? UNKNOWN_TX_GRACE_MS + 1; // aged out by default
      const nonces = createNonceAllocator(createNonceLease(), SIGNER);
      const cs = createCrashSafety({
        store,
        nonces,
        reader: createChainReader(args.publicClient),
        signer: SIGNER,
        logger: silentLogger,
        now: () => Date.now() + ageMs,
      });

      await cs.resyncNonces();
      return nonces.withNonce(async (n) => n);
    }

    // The fence's input filter. Both halves matter and neither is decorative: an intent with no
    // hash was never broadcast, so nothing on the wire holds its nonce; an intent with no nonce of
    // ours (a MANUAL action the operator broadcast from their own wallet) never occupied our
    // sequence at all, and reading `null` as a nonce would pin the lease at 1.
    it("fences only intents that hold one of our nonces", async () => {
      const store = createMemoryStateStore();
      const hashOnly = { ...input("pos-operator"), action: "liquidation" };
      const nonceOnly = { ...input("pos-unsent"), action: "liquidation" };
      await store.recordIntent(hashOnly);
      await store.recordIntent(nonceOnly);
      // An operator-broadcast intent: a hash, but none of our nonces.
      await store.transition(idempotencyKey(hashOnly), "submitted", { txHash: HASH });
      // Reserved and recorded, but the send never got as far as a hash.
      await store.transition(idempotencyKey(nonceOnly), "submitted", { nonce: 7 });

      const nonces = createNonceAllocator(createNonceLease(), SIGNER);
      const cs = createCrashSafety({
        store,
        nonces,
        // A node that knows every transaction it is asked about, and a signer that has sent none:
        // both intents would read as live if they were fenced at all, and the empty sequence is
        // what makes either one's floor visible.
        reader: createChainReader({
          getTransactionCount: vi.fn(async () => 0),
          getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => ({ hash })),
        } as unknown as PublicClient),
        signer: SIGNER,
        logger: silentLogger,
        now: () => Date.now() + UNKNOWN_TX_GRACE_MS + 1,
      });
      await cs.resyncNonces();

      // Neither raises a floor: the operator's hash holds no nonce of ours, and an unbroadcast
      // nonce has nothing on the wire to protect. Two nonces rather than one because a lease pushed
      // above the chain also reports the gap it left as a reclaimable hole, so the first hand-out
      // can be that hole — the second is where the lease actually sits.
      expect(await nonces.withNonce(async (n) => n)).toBe(0);
      expect(await nonces.withNonce(async (n) => n)).toBe(1);
    });

    it("does NOT rewind onto a live tx the node knows about", async () => {
      // The dangerous case: our tx is in the mempool at nonce 5, but this provider still reports
      // `pending: 5`. Re-seeding to 5 would sign the next action over it.
      const next = await nextNonceAfterResync({
        publicClient: chain(5, [HASH]),
        nonce: 5,
        txHash: HASH,
      });

      expect(next).toBe(6); // fenced past the live tx, not rewound onto it
    });

    it("still reclaims a nonce whose tx the node never accepted", async () => {
      // The case the pull-down exists for: signed and recorded at nonce 5, but the broadcast was
      // rejected (or never happened), so the node has never heard of the hash. Nothing is on chain
      // and nonce 5 is free — it MUST be reclaimed, or every later tx queues behind a gap forever.
      const next = await nextNonceAfterResync({
        publicClient: chain(5, []), // node does not know HASH, and the record has aged out
        nonce: 5,
        txHash: HASH,
      });

      expect(next).toBe(5); // reclaimed
    });

    it("holds the fence while a just-broadcast tx is still too young to be called unknown", async () => {
      // Behind a load-balanced RPC pool the backend we probe need not be the one we broadcast to, so
      // a tx that IS on the wire can read as unknown until it propagates. Reclaiming its nonce on
      // that answer would sign over a live tx — the same failure the fence exists to prevent, just
      // reached through a lying probe rather than a lagging `pending`.
      const next = await nextNonceAfterResync({
        publicClient: chain(5, []), // node claims not to know HASH...
        nonce: 5,
        txHash: HASH,
        ageMs: 1_000, // ...but we recorded it a second ago, so that "no" means nothing yet
      });

      expect(next).toBe(6); // still fenced
    });

    it("takes the chain's count when it is already ahead of the fence", async () => {
      const next = await nextNonceAfterResync({
        publicClient: chain(9, [HASH]), // chain moved on; the live tx at 5 is behind it
        nonce: 5,
        txHash: HASH,
      });

      expect(next).toBe(9);
    });

    it("does not fence on an intent that never recorded a hash", async () => {
      // No hash ⇒ we cannot ask the node about it — but reconcile only leaves such an intent live
      // when `pending > nonce`, so the chain's own count already sits above it. Nothing to fence.
      const next = await nextNonceAfterResync({ publicClient: chain(6, []), nonce: 5 });
      expect(next).toBe(6);
    });

    it("fences against the OTHER engine's in-flight tx (one signer, one nonce sequence)", async () => {
      // The arbitrageur runs both engines off one signer. A fence that only looked at the calling
      // engine's own action would happily rewind onto the other engine's live tx.
      const next = await nextNonceAfterResync({
        publicClient: chain(5, [HASH]),
        nonce: 5,
        txHash: HASH,
        action: "vault-acquisition", // a different action than the liquidation engine's
      });

      expect(next).toBe(6);
    });

    it("propagates a probe failure rather than dropping the fence", async () => {
      // Reading "unknown" from an RPC blip would drop the fence and let the rewind through, so an
      // unreachable node must fail the resync instead.
      const publicClient = {
        getTransactionCount: vi.fn(async () => 5),
        getTransaction: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      } as unknown as PublicClient;

      await expect(nextNonceAfterResync({ publicClient, nonce: 5, txHash: HASH })).rejects.toThrow(
        "ECONNREFUSED"
      );
    });
  });
});

// Private submission removes the assumption the fence above rests on: that a transaction we sent is
// one our own node can see. It cannot see a privately-submitted one — by design — so `isKnown` says
// no and `pending` omits it, and BOTH of the tests above would reach the wrong conclusion.
//
// These two must fail if `createCrashSafety` ever stops taking a reader, which is the whole point of
// the seam: the second one is the acute failure, because it does not merely reuse a nonce, it lets
// the engine re-drive a liquidation that is still live at the relay.
describe("resyncNonces — private submission, where the node cannot see our tx", () => {
  const blindChain = (pending: number, head = 100) =>
    ({
      getTransactionCount: vi.fn(async () => pending),
      getBlockNumber: vi.fn(async () => BigInt(head)),
      // Never knows the hash: that is what "private" means.
      getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
        throw new TransactionNotFoundError({ hash });
      }),
    }) as unknown as PublicClient;

  const relayReader = (status: RelayTxStatus["status"] | "throw", head = 100) =>
    createRelayAwareReader(
      createChainReader(blindChain(5, head)),
      {
        status: async () => {
          if (status === "throw") throw new Error("flashbots status failed: HTTP 503");
          return { status, maxBlockNumber: 0, isRevert: false, seenInMempool: false };
        },
      },
      silentLogger
    );

  /** Seed one submitted intent at nonce 5 and report the nonce the next send gets. */
  async function nextNonceWithReader(
    reader: ChainReader,
    over: { ageMs?: number; relayMaxBlock?: number; reclaimMarginBlocks?: number } = {}
  ) {
    const store = createMemoryStateStore();
    const intent = { ...input("pos-1"), action: "liquidation" };
    await store.recordIntent(intent);
    await store.transition(idempotencyKey(intent), "submitted", {
      nonce: 5,
      txHash: HASH,
      relayMaxBlock: over.relayMaxBlock,
    });

    const nonces = createNonceAllocator(createNonceLease(), SIGNER);
    const cs = createCrashSafety({
      store,
      nonces,
      signer: SIGNER,
      logger: silentLogger,
      reader,
      reclaimMarginBlocks: over.reclaimMarginBlocks,
      now: () => Date.now() + (over.ageMs ?? UNKNOWN_TX_GRACE_MS + 1),
    });
    await cs.resyncNonces();
    return nonces.withNonce(async (n) => n);
  }

  it("fences the nonce of a tx the relay is still holding", async () => {
    // public pending = 5, node isKnown = false, relay = PENDING, our intent holds nonce 5.
    // Without the relay-aware reader this rewinds to 5 and signs over a live liquidation.
    expect(await nextNonceWithReader(relayReader("PENDING"))).toBe(6);
  });

  it("fences it when the relay itself is unreachable, rather than assuming it is gone", async () => {
    // §4.6: a Flashbots outage must cost throughput, never nonce safety.
    expect(await nextNonceWithReader(relayReader("throw"))).toBe(6);
  });

  // Narrow but real: the relay knows a transaction is in a block before our RPC serves that block,
  // so `INCLUDED` can arrive while `isKnown` is still no. Reclaiming there would hand out a nonce
  // that a landed transaction already spent — the next send would die on `nonce too low`, which the
  // send path treats as ambiguous and the engines count as a genuine failure.
  it("fences a tx the relay reports INCLUDED before our node has the block", async () => {
    expect(await nextNonceWithReader(relayReader("INCLUDED"))).toBe(6);
  });

  // A terminal status does NOT release the nonce. `UNKNOWN` cannot be told apart from "the relay
  // forgot this hash", so letting any status free a nonce would put a third party's field in charge
  // of whether we sign over a live transaction.
  it("keeps fencing even when the relay reports the tx FAILED", async () => {
    const next = await nextNonceWithReader(relayReader("FAILED"), {
      relayMaxBlock: 120,
      reclaimMarginBlocks: 3,
    });
    expect(next).toBe(6);
  });

  // …and this is what releases it instead: the relay's own deadline for this transaction, recorded
  // when it was submitted, plus reorg headroom. Without it the reader — which fails closed by
  // design — fences forever and every later send queues behind the gap.
  it("releases the nonce once the chain is past the recorded horizon, whatever the relay says", async () => {
    const next = await nextNonceWithReader(relayReader("PENDING", 104), {
      relayMaxBlock: 100,
      reclaimMarginBlocks: 3,
    });
    expect(next).toBe(5);
  });

  it("does not release one block early", async () => {
    const next = await nextNonceWithReader(relayReader("PENDING", 103), {
      relayMaxBlock: 100,
      reclaimMarginBlocks: 3,
    });
    expect(next).toBe(6);
  });

  // The failure mode the wall clock always had: time passes whether or not blocks do, so a stalled
  // chain used to free a nonce the relay could still spend the moment it resumed. Height cannot.
  it("never releases while the chain is stalled, however old the transaction is", async () => {
    const next = await nextNonceWithReader(relayReader("PENDING", 100), {
      ageMs: 10_000_000,
      relayMaxBlock: 100,
      reclaimMarginBlocks: 3,
    });
    expect(next).toBe(6);
  });

  // A transaction submitted before this column existed, or one whose horizon could not be resolved.
  // It keeps the old behaviour — fenced by the reader — rather than being released on a guess.
  it("keeps fencing a tx with no recorded horizon", async () => {
    const next = await nextNonceWithReader(relayReader("PENDING", 10_000), {
      reclaimMarginBlocks: 3,
    });
    expect(next).toBe(6);
  });

  // Public submission keeps its old behaviour exactly: no horizon at all. A public transaction can
  // sit in a node's pool indefinitely, so age says nothing about whether it can still be mined —
  // only the node does.
  it("leaves a known public tx fenced no matter how old", async () => {
    const knowing = {
      getTransactionCount: vi.fn(async () => 5),
      getTransaction: vi.fn(async () => ({ hash: HASH })),
    } as unknown as PublicClient;
    expect(await nextNonceWithReader(createChainReader(knowing), { ageMs: 10_000_000 })).toBe(6);
  });
});

// Releasing a dead nonce from the fence stops it *raising* the floor, but the lease is a
// monotonic counter and never comes back down to it — so the hole has to be handed out explicitly.
// Public submission hides this: a mempool evicts a dropped transaction's dependents, the floor
// collapses on its own, and the next send fills the gap. A privately-submitted transaction was never
// in a mempool, so nothing cascades and the hole is permanent.
describe("resyncNonces — reissuing a nonce hole", () => {
  /** A chain whose pending count stops at the gap (verified anvil behaviour) and knows `known`. */
  const gappedChain = (pending: number, known: Hex[]) =>
    ({
      getTransactionCount: vi.fn(async () => pending),
      getBlockNumber: vi.fn(async () => 100n),
      getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
        if (!known.includes(hash)) throw new TransactionNotFoundError({ hash });
        return { hash };
      }),
    }) as unknown as PublicClient;

  /** Seed intents at `nonces`, resync, and report the nonce the next send actually gets. */
  async function nextNonceWithIntents(args: {
    intents: Array<{ nonce: number; hash: Hex; ageMs?: number }>;
    publicClient: PublicClient;
  }) {
    const store = createMemoryStateStore();
    for (const [i, it] of args.intents.entries()) {
      const intent = { ...input(`pos-${i}`) };
      await store.recordIntent(intent);
      await store.transition(idempotencyKey(intent), "submitted", {
        nonce: it.nonce,
        txHash: it.hash,
      });
    }
    const nonces = createNonceAllocator(createNonceLease(), SIGNER);
    const cs = createCrashSafety({
      store,
      nonces,
      reader: createChainReader(args.publicClient),
      signer: SIGNER,
      logger: silentLogger,
      now: () => Date.now() + UNKNOWN_TX_GRACE_MS + 1,
    });
    await cs.resyncNonces();
    return nonces.withNonce(async (n) => n);
  }

  const H7 = "0xh7" as Hex;
  const H8 = "0xh8" as Hex;

  it("hands out the hole rather than piling further transactions behind it", async () => {
    // Nonce 6 was dropped (the node never knew it); 7 and 8 were forwarded and are queued, so the
    // chain's pending count stops at 6 while the fence floor sits at 9.
    const next = await nextNonceWithIntents({
      intents: [
        { nonce: 6, hash: HASH },
        { nonce: 7, hash: H7 },
        { nonce: 8, hash: H8 },
      ],
      publicClient: gappedChain(6, [H7, H8]),
    });
    expect(next).toBe(6);
  });

  // The invariant that separates reissuing a dead hole from simply capping the lease at the chain's
  // count: while the transaction at the hole may still land, its nonce must stay untouchable.
  it("does NOT hand out the hole while a live transaction still holds it", async () => {
    const next = await nextNonceWithIntents({
      intents: [
        { nonce: 6, hash: HASH },
        { nonce: 7, hash: H7 },
      ],
      publicClient: gappedChain(6, [HASH, H7]), // the node still knows 6 — it may yet mine
    });
    expect(next).toBe(8);
  });

  it("reports no hole when the chain has already caught up", async () => {
    const next = await nextNonceWithIntents({
      intents: [{ nonce: 6, hash: HASH }],
      publicClient: gappedChain(7, [HASH]), // 6 mined; pending is past it
    });
    expect(next).toBe(7);
  });
});
