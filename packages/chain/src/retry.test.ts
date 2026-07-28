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

    it("bounds each attempt, so a peer that never answers is retried rather than hung on", async () => {
      // The failure this guards is silence, not an error: a server that accepts the connection and
      // then says nothing. Retry cannot see that on its own, so the poll loop awaiting it would
      // simply stop. Here the "server" only ever resolves when its request is aborted.
      const good = { ok: true, status: 200 } as Response;
      let attempts = 0;
      global.fetch = vi.fn((_url: string, init?: RequestInit) => {
        attempts++;
        if (attempts > 1) return Promise.resolve(good);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }) as unknown as typeof global.fetch;

      expect(await fetchWithRetry("http://x", undefined, { ...FAST, timeoutMs: 10 })).toBe(good);
      expect(attempts).toBe(2); // the hung attempt timed out and the retry went through
    });

    it("gives each attempt a fresh signal, so a retry does not start out aborted", async () => {
      // An AbortSignal is single-use. Sharing one across attempts would abort every retry
      // instantly, turning the timeout into a hard failure instead of a bounded attempt.
      const good = { ok: true, status: 200 } as Response;
      const signals: (AbortSignal | null | undefined)[] = [];
      let attempts = 0;
      global.fetch = vi.fn((_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        attempts++;
        if (attempts > 2) return Promise.resolve(good);
        return Promise.reject(new Error("boom"));
      }) as unknown as typeof global.fetch;

      await fetchWithRetry("http://x", undefined, { ...FAST, timeoutMs: 50 });
      expect(signals).toHaveLength(3);
      expect(new Set(signals).size).toBe(3); // three distinct signals, not one reused
      expect(signals.every((s) => s?.aborted === false)).toBe(true);
    });

    it("defers to a caller-supplied signal instead of imposing its own", async () => {
      const ok = { ok: true, status: 200 } as Response;
      const controller = new AbortController();
      global.fetch = vi.fn().mockResolvedValue(ok);

      await fetchWithRetry("http://x", { signal: controller.signal }, FAST);
      expect(vi.mocked(global.fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
    });
  });
});
