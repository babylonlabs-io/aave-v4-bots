# Refactor-003 — Uniform read-retry policy

Status: proposed (deferred to its own PR)
Scope: `@repo/chain`, `@repo/engine` (both engines), `@repo/runtime`
Non-goal: any change to the write/broadcast path or nonce sequencing.

## Problem

Read call sites are inconsistent about retry. Two arbitrage reads are wrapped in the
app-level `withRetry` (`@repo/chain`); the other ~10 reads across both engines are not:

- `packages/engine/src/arbitrage/engine.ts:420` — `getWbtcMeta` (boot) — wrapped
- `packages/engine/src/arbitrage/engine.ts:439` — `logBalance` — wrapped
- everything else (`previewEscrowedVaults`, `estimateContractGas`, the executor's
  `readAllowance`, the liquidation engine's `readContract`/`simulateContract`, …) — bare

This surfaced during review as "the arb allowance read lost its `withRetry` when it moved
into the executor seam." That framing is misleading (see below), but the underlying
inconsistency is real and worth removing.

## Current retry topology (verified against viem 2.41.2)

There are **three** retry layers already, not zero:

1. **Transport** — `instrumentedHttp` wraps viem's `http()` transport, which retries on its
   own. Defaults (`buildRequest.js`): `retryCount = 3`, `retryDelay = 150ms` exponential
   (~150 / 300 / 600ms). The services pass no override, so these defaults are live on
   **every** JSON-RPC call — reads *and* writes. `shouldRetry` retries the transient class
   only: network/fetch errors, timeouts, rate-limits (HTTP 429 / RPC `-32005`), 5xx, and
   unknown-code (`-1` / internal `-32603`). It does **not** retry deterministic errors
   (execution revert, invalid params, nonce-too-low, "already known") — so a write is never
   silently re-sent as a *different* tx; a re-send is the identical signed raw tx (same hash),
   which is idempotent at the mempool.
2. **App-level `withRetry`** — `maxAttempts = 3`, `initialDelayMs = 1000`,
   `maxDelayMs = 30000`, `backoffMultiplier = 2`, with jitter. Retries on **any** thrown
   error (no predicate). Applied at only the two sites above.
3. **Poll loop** — the whole cycle re-runs on the next interval; the ultimate backstop for
   anything the inner layers exhaust.

So the "bare" reads are **not un-retried** — layer (1) covers them uniformly. The real
inconsistency is that the two wrapped sites additionally get layer (2)'s much longer window
(~30s vs ~1s). Nothing is unprotected; the protection is just uneven.

## Options

### Option A — make the transport the single, explicit read-retry policy (recommended)

Delete the two `withRetry` wrappers and rely on the transport retry, but make it
**deliberate** instead of an inherited default: thread `retryCount` / `retryDelay` from
config through `instrumentedHttp` (→ `http(url, { retryCount, retryDelay })`).

- Pros: one layer, uniform by construction (every read already flows through this
  transport), minimal code, no redundancy. Writes keep the same safe (identical-raw-tx)
  retry they have today.
- Cons: shorter max window than the current 30s app-level wrap — but the poll loop already
  covers longer outages, and the two wrapped sites don't need special treatment. Tuning
  `retryCount` affects writes too, which is fine (that retry is already deterministic-safe).
- Net: smallest change, removes the redundancy, and the inconsistency disappears because
  there's no per-call-site retry left to be inconsistent about.

### Option B — a retrying read wrapper on the `publicClient`

Wrap the read methods (`readContract`, `simulateContract`, `estimateContractGas`,
`getBalance`, `multicall`, …) in `withRetry`; hand engines the wrapped client; leave writes
untouched.

- Pros: app-level (long-window) retry, uniform, reads-only.
- Cons: stacks on top of the transport retry (up to ~9 attempts / 15s+ per read) unless we
  also disable the transport's retry for reads — which viem's transport can't do
  selectively, so we'd set `retryCount = 0` globally and lose the write-side retry too.
  Also fiddly: the wrapper must enumerate viem's read surface and track it across upgrades.

## Recommendation

**Option A.** Make the transport retry explicit + config-driven, delete the two ad-hoc
`withRetry` calls. Uniform, minimal, no redundancy, write path unchanged.

## Checklist (for the implementing PR)

- [ ] `instrumentedHttp` accepts `{ retryCount, retryDelay }` and forwards to `http()`.
- [ ] `@repo/runtime` passes them from config (new env fields, sensible defaults matching
      viem's 3 / 150ms, or slightly higher).
- [ ] Remove the two `withRetry` wraps in `arbitrage/engine.ts` (and drop the now-unused
      `withRetry` import + `retryConfig` field if nothing else uses them).
- [ ] Confirm no read path still hand-rolls a retry; the transport is the only read-retry.
- [ ] Verify the write path is untouched (still transport-retry only; no new re-broadcast).
- [ ] `pnpm typecheck && pnpm test && npx biome check packages services`.
