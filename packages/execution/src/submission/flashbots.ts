import type { Hex } from "viem";
import { SubmitRejectedError, type Submitter } from "./index";

// Flashbots Protect adapter — private submission, so a transaction is never visible in the public
// mempool and cannot be front-run from it. See `docs/design-026-private-relay-submission.md`.
//
// Two endpoints, both plain HTTP so the whole adapter is testable against a scripted `fetch`:
//
//   POST {rpcUrl}      `eth_sendRawTransaction` — submit
//   GET  {statusUrl}/tx/{hash}                  — status, the liveness source
//
// The status half exists because a private transaction is invisible to OUR node: `isKnown` and the
// `pending` nonce count both miss it, and without a second source the nonce fence and reconcile both
// make unsafe decisions (§4.1). The response shape below was verified against the live endpoint.

/** What Protect reports for a submitted transaction. Verified against the live API. */
export interface RelayTxStatus {
  /**
   * `UNKNOWN` is ambiguous between "never seen it" and "expired from the index", which is why
   * §4.5 never lets status alone free a nonce — only the recorded horizon does.
   */
  status: "PENDING" | "INCLUDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  /**
   * The relay's own deadline for this transaction — after this block it stops being offered to
   * builders. Read rather than assumed, so the reclaim horizon is not a constant copied from docs.
   */
  maxBlockNumber: number;
  /**
   * Set when the relay's simulation says this transaction cannot succeed. Its presence means our
   * transaction is **defective, not out-competed** — an alert, and never counted as competition.
   *
   * Load-bearing because acceptance proves nothing: the relay returns a hash for a transaction it
   * has already simulated and knows can never be included (observed with `InsufficientFunds`).
   */
  simError?: string;
  /** The transaction would have reverted — i.e. we lost the race, rather than simply not landing. */
  isRevert: boolean;
  /** Whether the transaction leaked to the public mempool. Should be `false` while private. */
  seenInMempool: boolean;
}

/** Injected so tests script the relay without a network. Matches the global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FlashbotsConfig {
  /** Protect RPC that accepts `eth_sendRawTransaction`. */
  rpcUrl: string;
  /** Base URL of the status API; `/tx/{hash}` is appended. */
  statusUrl: string;
  fetch?: FetchLike;
  /** Defaults to `DEFAULT_SUBMIT_TIMEOUT_MS`. */
  submitTimeoutMs?: number;
  /** Defaults to `DEFAULT_STATUS_TIMEOUT_MS`. */
  statusTimeoutMs?: number;
  /**
   * How each broadcast was answered. A callback rather than a metrics dependency, matching how
   * `instrumentedHttp` takes `recordRpcCall` — this package stays free of `prom-client`.
   */
  onResult?: (result: "accepted" | "rejected" | "ambiguous") => void;
}

interface JsonRpcResponse {
  result?: string;
  error?: { code?: number; message?: string };
}

/**
 * Relay errors that do **not** mean "nothing was broadcast", despite arriving as a rejection.
 *
 * A structured rejection normally proves the relay processed our request and declined it, so the
 * transaction is nowhere. These two break that: both say a transaction at this nonce already exists
 * — ours, or someone else's — so treating them as a clean abort would free a nonce that is spoken
 * for. This mirrors the deliberate `nonce too low` exclusion on the public path.
 */
const NOT_CLEAN = [/already known/i, /nonce too low/i, /replacement transaction underpriced/i];

/**
 * How long a submit may take before it is abandoned as ambiguous.
 *
 * This one runs under the nonce allocator's lock — `withNonce` serializes on a promise chain, so
 * every later send and every `resync`, from **both** engines, waits behind it. A relay that accepts
 * the connection and then answers nothing would otherwise hold that lock for as long as the socket
 * stays open, which stops the bot trading entirely rather than merely losing one transaction.
 *
 * Chosen to sit under a cycle: `POLLING_INTERVAL_MS` defaults to 12s, and the cycle needs room for
 * the pre-broadcast write and the rest of the batch. It is not chosen tight — aborting a submit the
 * relay would have accepted a second later costs a transaction that was about to land, so the
 * budget is generous and only the wedge is what it prevents. An operator running a faster loop
 * should lower it to match.
 */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 8_000;

/**
 * How long a status probe may take. Shorter than a submit: nothing waits on its answer being
 * *useful* — `createRelayAwareReader` treats a failed probe as "still in flight" — so failing fast
 * costs only a fenced nonce for one more cycle, while a slow probe delays reconcile for every live
 * intent in the pass.
 */
export const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

/** `AbortSignal.timeout` rewrapped so the thrown error names the endpoint and the budget. */
async function fetchWithin(
  doFetch: FetchLike,
  url: string,
  timeoutMs: number,
  label: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`flashbots ${label} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

/**
 * `./flashbots-protect` — submit privately, and read back a transaction's relay status.
 *
 * **Error classification is deliberately asymmetric.** Only a well-formed JSON-RPC rejection counts
 * as clean (nothing on the wire); everything else — transport failure, timeout, 429/5xx, malformed
 * body — stays ambiguous and propagates. That is the safe direction: a wrongly-clean error frees a
 * nonce under a transaction that may still land, while a wrongly-ambiguous one only costs the
 * breaker a failure it did not need to count.
 */
export function createFlashbotsProtectSubmitter(
  config: FlashbotsConfig
): Submitter & { status(hash: Hex): Promise<RelayTxStatus> } {
  const doFetch = config.fetch ?? ((url, init) => fetch(url, init));
  const report = config.onResult ?? (() => {});
  const submitTimeoutMs = config.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  const statusTimeoutMs = config.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;

  return {
    async send(serializedTransaction) {
      // Every exit from here is counted exactly once. `reject` classifies the answers the relay
      // gave us; the `catch` at the bottom classifies the ones it never gave — a timeout, a dropped
      // connection, anything unexpected — which would otherwise escape uncounted and leave the
      // submit metric silent during exactly the incident it exists to reveal.
      let classified = false;
      /** Report, then throw. */
      const reject = (result: "rejected" | "ambiguous", error: Error): never => {
        classified = true;
        report(result);
        throw error;
      };

      try {
        const response = await fetchWithin(doFetch, config.rpcUrl, submitTimeoutMs, "submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_sendRawTransaction",
            params: [serializedTransaction],
          }),
        });

        // A non-2xx body tells us nothing about whether the relay took the transaction: a 502 from
        // a proxy can sit in front of a relay that accepted it. Ambiguous.
        if (!response.ok) {
          reject("ambiguous", new Error(`flashbots submit failed: HTTP ${response.status}`));
        }

        let body: JsonRpcResponse;
        try {
          body = (await response.json()) as JsonRpcResponse;
        } catch {
          // We cannot tell what the relay did with it. Ambiguous, by the rule above.
          return reject("ambiguous", new Error("flashbots submit returned a malformed response"));
        }

        if (body.error) {
          const message = body.error.message ?? "unknown relay error";
          if (NOT_CLEAN.some((re) => re.test(message))) {
            return reject("ambiguous", new Error(`flashbots rejected the transaction: ${message}`));
          }
          return reject("rejected", new SubmitRejectedError(message));
        }
        if (!body.result) {
          return reject(
            "ambiguous",
            new Error("flashbots submit returned neither a hash nor an error")
          );
        }
        report("accepted");
        return body.result as Hex;
      } catch (error) {
        // Nothing came back at all. The relay may still have taken the transaction, so this is
        // ambiguous by the same rule as a 502 — never a clean rejection.
        if (!classified) report("ambiguous");
        throw error;
      }
    },

    async status(hash) {
      const response = await fetchWithin(
        doFetch,
        `${config.statusUrl}/tx/${hash}`,
        statusTimeoutMs,
        "status"
      );
      if (!response.ok) {
        throw new Error(`flashbots status failed: HTTP ${response.status}`);
      }
      return (await response.json()) as RelayTxStatus;
    },
  };
}
