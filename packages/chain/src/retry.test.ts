import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, withRetry } from "./retry";

// Tiny delays keep the exponential-backoff sleeps sub-millisecond so the suite
// stays fast on real timers.
const FAST = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, backoffMultiplier: 2 };

describe("@repo/chain retry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("withRetry", () => {
    it("returns the result without retrying on first success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      expect(await withRetry(fn, FAST)).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries transient failures then succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("ok");

      expect(await withRetry(fn, FAST)).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws the last error after exhausting attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));
      await expect(withRetry(fn, FAST)).rejects.toThrow("always fails");
      expect(fn).toHaveBeenCalledTimes(FAST.maxAttempts);
    });
  });

  describe("fetchWithRetry", () => {
    it("returns immediately on a successful response", async () => {
      const ok = { ok: true, status: 200 } as Response;
      global.fetch = vi.fn().mockResolvedValue(ok);

      expect(await fetchWithRetry("http://x", undefined, FAST)).toBe(ok);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("retries on 5xx then returns the eventual success", async () => {
      const bad = { ok: false, status: 503, statusText: "Unavailable" } as Response;
      const good = { ok: true, status: 200 } as Response;
      global.fetch = vi.fn().mockResolvedValueOnce(bad).mockResolvedValue(good);

      expect(await fetchWithRetry("http://x", undefined, FAST)).toBe(good);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry on a 4xx response", async () => {
      const notFound = { ok: false, status: 404, statusText: "Not Found" } as Response;
      global.fetch = vi.fn().mockResolvedValue(notFound);

      expect(await fetchWithRetry("http://x", undefined, FAST)).toBe(notFound);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
