import type { NonceAllocator } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { createMemoryStateStore, idempotencyKey } from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";
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
});
