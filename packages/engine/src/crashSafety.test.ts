import { type NonceAllocator, createNonceAllocator, createNonceLease } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import { type Address, type Hex, type PublicClient, TransactionNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";

import { type CrashSafetyConfig, createCrashSafety } from "./crashSafety";

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

/** A slot that records whether it was settled, standing in for the risk gate's. */
function fakeSlot(): RiskSlot & { settled: unknown[] } {
  const settled: unknown[] = [];
  return { allowed: true, reason: "", settle: (o) => settled.push(o), settled };
}

const publicClient = { getTransactionCount: vi.fn(async () => 7) } as unknown as PublicClient;

const crash = (over: Partial<CrashSafetyConfig> = {}) =>
  createCrashSafety({ publicClient, signer: SIGNER, logger: silentLogger, ...over });

/** An allocator that hands out `nonce` and records the region held under its lock. */
const allocator = (nonce: number): NonceAllocator => ({
  withNonce: (send) => send(nonce),
  resync: vi.fn(async () => {}),
});

describe("createCrashSafety", () => {
  describe("send", () => {
    it("passes the allocator's reserved nonce to the callback", async () => {
      const seen: (number | undefined)[] = [];
      await crash({ nonces: allocator(5) }).send(async (n) => {
        seen.push(n);
        return HASH;
      });
      expect(seen).toEqual([5]);
    });

    // Regression: nonce 0 is a *valid* reserved nonce (a signer's first tx). The engine writes
    // `broadcast(nonce ?? localNonce)`; with `||` that 0 would be silently replaced.
    it("passes a reserved nonce of 0 through, not undefined", async () => {
      const seen: (number | undefined)[] = [];
      await crash({ nonces: allocator(0) }).send(async (n) => {
        seen.push(n);
        return HASH;
      });
      expect(seen).toEqual([0]);
      expect(seen[0]).not.toBeUndefined();
    });

    it("calls back with undefined when there is no allocator", async () => {
      const seen: (number | undefined)[] = [];
      await crash().send(async (n) => {
        seen.push(n);
        return HASH;
      });
      expect(seen).toEqual([undefined]);
    });

    it("propagates a send error (an ambiguous broadcast must not be swallowed)", async () => {
      await expect(
        crash({ nonces: allocator(3) }).send(async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
    });
  });

  it("reports whether an allocator is wired up", () => {
    expect(crash().allocated).toBe(false);
    expect(crash({ nonces: allocator(1) }).allocated).toBe(true);
  });

  describe("markPending vs transition — the throw/swallow split", () => {
    // Pre-broadcast: if the reserved nonce cannot be recorded we must NOT broadcast against it.
    it("markPending propagates a store failure", async () => {
      const store = createMemoryStateStore();
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("db down"));
      await expect(crash({ store }).markPending("id", 4)).rejects.toThrow("db down");
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
      await expect(crash().markPending("id", 4)).resolves.toBeUndefined();
      await expect(crash().transition("id", "confirmed")).resolves.toBeUndefined();
    });
  });

  describe("claim", () => {
    it("claims a fresh subject and returns its intent id", async () => {
      const store = createMemoryStateStore();
      const slot = fakeSlot();
      const result = await crash({ store }).claim(slot, input("p"));

      expect(result).toEqual({ claimed: true, intentId: idempotencyKey(input("p")) });
      expect(slot.settled).toEqual([]); // still in flight — the caller settles later
    });

    // A duplicate means nothing was broadcast: free the exposure slot, don't blame the chain.
    it("refuses a duplicate live intent and settles the slot as abandoned", async () => {
      const store = createMemoryStateStore();
      const cs = crash({ store });
      await cs.claim(fakeSlot(), input("p"));

      const slot = fakeSlot();
      expect(await cs.claim(slot, input("p"))).toEqual({ claimed: false });
      expect(slot.settled).toEqual([{ ok: false, abandoned: true }]);
    });

    it("without a store, always claims and never yields an intent id", async () => {
      const slot = fakeSlot();
      expect(await crash().claim(slot, input("p"))).toEqual({ claimed: true });
      expect(slot.settled).toEqual([]);
    });
  });

  describe("reconcile / resyncNonces", () => {
    it("both no-op without a store / allocator", async () => {
      await expect(crash().reconcile("liquidation")).resolves.toBeUndefined();
      await expect(crash().resyncNonces()).resolves.toBeUndefined();
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

    /** Seed a live intent at `nonce`/`txHash`, then resync, and report the next nonce handed out. */
    async function nextNonceAfterResync(args: {
      publicClient: PublicClient;
      nonce: number;
      txHash?: Hex;
      action?: string;
    }) {
      const store = createMemoryStateStore();
      const intent = { ...input("pos-1"), action: args.action ?? "liquidation" };
      await store.recordIntent(intent);
      await store.transition(idempotencyKey(intent), "submitted", {
        nonce: args.nonce,
        ...(args.txHash ? { txHash: args.txHash } : {}),
      });

      const nonces = createNonceAllocator(createNonceLease(), SIGNER);
      const cs = createCrashSafety({
        store,
        nonces,
        publicClient: args.publicClient,
        signer: SIGNER,
        logger: silentLogger,
      });

      await cs.resyncNonces();
      return nonces.withNonce(async (n) => n);
    }

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
        publicClient: chain(5, []), // node does not know HASH
        nonce: 5,
        txHash: HASH,
      });

      expect(next).toBe(5); // reclaimed
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
