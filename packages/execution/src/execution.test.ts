import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextNonce, waitForReceipt, waitForReceiptWithTimeout } from "./index";

const HASH = "0xhash" as `0x${string}`;
const ADDR = "0xaddr" as `0x${string}`;

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
});
