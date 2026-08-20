import { http, type HttpTransportConfig, type Transport } from "viem";
import type { RetryConfig } from "./retry";

export type RpcCallObserver = (method: string) => void;

/**
 * Translate this repo's `RetryConfig` into viem's transport options.
 *
 * The two are **not** interchangeable, which is why the mapping lives in one place:
 *
 * - `retryCount` counts *retries*, not attempts — viem loops `while (count < retryCount)` — so it
 *   is `maxAttempts - 1`. Passing `maxAttempts` straight through buys a silent extra attempt.
 * - viem takes a single base `retryDelay` and applies its own exponential schedule, plus
 *   `Retry-After` when a provider sends one. `maxDelayMs`, `backoffMultiplier` and jitter have no
 *   equivalent, and are dropped rather than approximated into something that reads exact.
 *
 * Only the attempt count and the per-attempt timeout translate cleanly.
 */
function toTransportPolicy(
  retry: RetryConfig
): Pick<HttpTransportConfig, "retryCount" | "retryDelay" | "timeout"> {
  return {
    retryCount: Math.max(0, retry.maxAttempts - 1),
    retryDelay: retry.initialDelayMs,
    ...(retry.timeoutMs === undefined ? {} : { timeout: retry.timeoutMs }),
  };
}

/**
 * Count every JSON-RPC method in one outbound body.
 *
 * viem batches several calls into a single request, so the body is either one object or an array of
 * them. Both are counted per method, which is the unit providers bill in.
 */
function observeBody(body: unknown, observer: RpcCallObserver): void {
  if (typeof body !== "string") return;
  const parsed: unknown = JSON.parse(body);
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    const method = (call as { method?: unknown })?.method;
    if (typeof method === "string") observer(method);
  }
}

/**
 * viem's HTTP transport with this process's retry policy applied, reporting every outbound
 * JSON-RPC method to `observer`.
 *
 * The observer hangs off `onFetchRequest`, which viem invokes immediately before each `fetch` —
 * *inside* the request function that its retry wraps. That placement is the point: an observer on
 * the transport's `request` sees one call however many times viem retries it, while the provider
 * bills every attempt, so the counter would under-report exactly during the incident it exists to
 * reveal. `onFetchResponse` will not do either: it never fires for a network failure or a timeout,
 * which are the attempts most worth counting.
 *
 * The hook returns nothing on purpose — viem then falls back to its own `{ ...init, url }`, so
 * observing cannot alter the request it observes.
 */
export function instrumentedHttp(
  url: string | undefined,
  observer: RpcCallObserver,
  opts?: HttpTransportConfig & { retry?: RetryConfig }
): Transport {
  const { retry, ...transportOpts } = opts ?? {};
  return http(url, {
    ...(retry ? toTransportPolicy(retry) : {}),
    ...transportOpts,
    onFetchRequest(_request, init) {
      try {
        observeBody(init.body, observer);
      } catch {
        // Never let metrics break a real RPC call.
      }
    },
  });
}
