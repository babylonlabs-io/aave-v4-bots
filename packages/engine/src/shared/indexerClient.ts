import { type RetryConfig, fetchJsonWithRetry } from "@repo/chain";

/**
 * The one thing that talks to the indexer.
 *
 * Ponder is reached over plain `fetch`, not viem, so the RPC transport's retry policy does not
 * cover it — this is where the same process-wide policy is applied to the other protocol. Built
 * once per process and shared by both engines and the liveness guard, so no caller can read the
 * indexer with a different policy, or none.
 *
 * It owns the base URL, the retry policy and the readiness semantics. It deliberately does **not**
 * own the route shapes: `LiquidatablePosition` and `EscrowedVault` are engine domain types, and
 * moving them here to give the client typed per-route methods would drag that domain into shared
 * code that every engine depends on. Callers name their own route and response type; the client
 * guarantees only how the request is made.
 */
export interface IndexerClient {
  /** GET a route relative to the indexer base, with this process's retry policy applied. */
  read<T>(route: string): Promise<T>;
  /**
   * Ponder's own `/ready`, asked exactly once.
   *
   * Named apart from `read` because it must **not** retry: `fetchWithRetry` backs off on 5xx, and
   * Ponder answers `/ready` with 503 for as long as it is backfilling — the expected answer to a
   * question we mean to ask repeatedly, not a failure. A retrying client with one quietly
   * non-retrying method is a trap; two named methods are not.
   */
  probeReady(): Promise<boolean>;
  /** Poll `probeReady` until it succeeds or the budget runs out. `false` ⇒ the deadline passed. */
  waitUntilReady(opts: {
    timeoutMs: number;
    onWaiting?: () => void;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<boolean>;
}

export function createIndexerClient(deps: {
  baseUrl: string;
  retry?: Partial<RetryConfig>;
}): IndexerClient {
  const { baseUrl, retry } = deps;

  const probeReady = async (timeoutMs: number): Promise<boolean> => {
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch {
      // Unreachable and not-ready mean the same thing to every caller: do not trade yet.
      return false;
    }
  };

  return {
    read: <T>(route: string) => fetchJsonWithRetry<T>(`${baseUrl}${route}`, retry),

    probeReady: () => probeReady(2_000),

    async waitUntilReady({ timeoutMs, onWaiting, pollIntervalMs = 2_000, now = Date.now, sleep }) {
      const rest = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const deadline = now() + timeoutMs;
      let warned = false;

      // Both the probe and the sleep are clamped to what is left of the budget. Clamping only the
      // sleep is not enough: a `/ready` that hangs would then burn a full poll interval past the
      // deadline before anyone noticed it had passed.
      while (now() < deadline) {
        const remaining = Math.max(0, deadline - now());
        if (await probeReady(Math.min(pollIntervalMs, remaining))) return true;
        if (!warned) {
          onWaiting?.();
          warned = true;
        }
        await rest(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
      }
      return false;
    },
  };
}
