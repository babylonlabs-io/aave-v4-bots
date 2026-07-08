import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNonceAllocator,
  createNonceLease,
  nextNonce,
  waitForReceipt,
  waitForReceiptWithTimeout,
} from "./index";

const HASH = "0xhash" as `0x${string}`;
const ADDR = "0xaddr" as `0x${string}`;
const SIGNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

type PublicClientArg = Parameters<typeof waitForReceipt>[0];

describe("@repo/execution", () => {
  describe("nextNonce", () => {
    it("reads the pending transaction count", async () => {
      const client = { getTransactionCount: vi.fn().mockResolvedValue(7) };
      const nonce = await nextNonce(client as unknown as PublicClientArg, ADDR);

      expect(nonce).toBe(7);
      expect(client.getTransactionCount).toHaveBeenCalledWith({
        address: ADDR,
        blockTag: "pending",
      });
    });
  });

  describe("waitForReceipt", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns the receipt when it resolves before the timeout", async () => {
      const receipt = { status: "success", blockNumber: 1n };
      const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) };

      // Do not advance timers: the timeout rejecter never fires.
      await expect(waitForReceipt(client as unknown as PublicClientArg, HASH, 5000)).resolves.toBe(
        receipt
      );
    });

    it("returns null when the timeout elapses first", async () => {
      const client = { waitForTransactionReceipt: () => new Promise(() => {}) }; // never resolves
      const promise = waitForReceipt(client as unknown as PublicClientArg, HASH, 5000);

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeNull();
    });

    it("re-throws non-timeout errors", async () => {
      const client = {
        waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc down")),
      };
      await expect(
        waitForReceipt(client as unknown as PublicClientArg, HASH, 5000)
      ).rejects.toThrow("rpc down");
    });
  });

  describe("waitForReceiptWithTimeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("warns with the context prefix on timeout and returns null", async () => {
      const client = { waitForTransactionReceipt: () => new Promise(() => {}) };
      const promise = waitForReceiptWithTimeout(
        client as unknown as PublicClientArg,
        HASH,
        5000,
        "swap"
      );

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("swap "));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(HASH));
    });

    it("does not warn when the receipt arrives in time", async () => {
      const receipt = { status: "success" };
      const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) };

      await expect(
        waitForReceiptWithTimeout(client as unknown as PublicClientArg, HASH, 5000)
      ).resolves.toBe(receipt);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("NonceAllocator", () => {
    const setup = () => {
      const lease = createNonceLease();
      return { alloc: createNonceAllocator(lease, SIGNER) };
    };

    it("reserve throws until seeded, then allocates from the chain seed", async () => {
      const { alloc } = setup();
      await expect(alloc.withNonce(async (n) => n)).rejects.toThrow(/not seeded/);

      await alloc.resync(() => Promise.resolve(10));
      expect(await alloc.withNonce(async (n) => n)).toBe(10);
      expect(await alloc.withNonce(async (n) => n)).toBe(11);
    });

    it("hands concurrent callers a gapless, duplicate-free sequence", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(0));

      const nonces = await Promise.all(
        Array.from({ length: 20 }, () => alloc.withNonce(async (n) => n))
      );

      expect(nonces).toEqual([...Array(20).keys()]); // 0..19, in call order
      expect(new Set(nonces).size).toBe(20); // no duplicates
    });

    it("does NOT reuse the nonce after a thrown send (no rollback)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      await expect(
        alloc.withNonce(async () => {
          throw new Error("ambiguous send");
        })
      ).rejects.toThrow("ambiguous send");

      // 5 is burned; the next send gets 6 (reclaim is the chain's job, not a rollback).
      expect(await alloc.withNonce(async (n) => n)).toBe(6);
    });

    it("a rejected section does not poison the lock chain", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(0));

      await expect(
        alloc.withNonce(async () => {
          throw new Error("x");
        })
      ).rejects.toThrow("x");
      expect(await alloc.withNonce(async (n) => n)).toBe(1);
    });

    it("serializes resync against an in-flight withNonce (no mid-flight rewind)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const p1 = alloc.withNonce(async (n) => {
        await gate; // hold the lock at nonce 5
        return n;
      });
      const p2 = alloc.resync(() => Promise.resolve(100)); // queued behind p1
      const p3 = alloc.withNonce(async (n) => n); // queued behind resync

      release();
      expect(await p1).toBe(5);
      await p2;
      expect(await p3).toBe(100); // saw the resync, not a stale 6
    });

    it("reads the chain INSIDE the lock (no lost update vs an in-flight withNonce)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      let chain = 5;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      // In-flight send reserves 5 and, while the lock is held, "broadcasts" — advancing the
      // chain to 6. A resync whose read happened OUTSIDE the lock would capture the stale 5
      // and rewind; reading inside the lock sees 6.
      const p1 = alloc.withNonce(async (n) => {
        await gate;
        chain = 6;
        return n;
      });
      const p2 = alloc.resync(async () => chain);

      release();
      expect(await p1).toBe(5);
      await p2;
      expect(await alloc.withNonce(async (n) => n)).toBe(6); // not rewound to a stale 5
    });

    it("resync SET pulls the lease down to reclaim (Case C)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(20));
      expect(await alloc.withNonce(async (n) => n)).toBe(20);

      await alloc.resync(() => Promise.resolve(10)); // chain shows 10 free (e.g. a dropped tx)
      expect(await alloc.withNonce(async (n) => n)).toBe(10);
    });
  });
});
