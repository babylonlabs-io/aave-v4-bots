# Spec — Dual-engine shared nonce authority (resolves #6)

**Status:** DRAFT v4 for discussion · **Relates to:** `@repo/persistence` (Phase D) ·
**Resolves:** #6 "dual-engine nonce manager"

> **v4.1 changes (after Codex implementation review):** `resync` now takes a `readChainNonce`
> thunk read **inside** the lock (a value read outside was a lost-update race that could rewind
> the lease — G1 bug); the arbitrage `run()` now **stops the cycle** on a send error (like
> liquidation) via a `AcquireOutcome` return. Both are implemented + tested.
>
> **v4 changes (after 2nd Codex review):** on a send error the intent is **kept live** (not
> terminalized) — terminalizing let the next cycle re-drive an action whose tx was still
> pending, breaking G2. `reconcilePending` now runs **every cycle** to resolve live intents
> by reserved-nonce vs. chain. Added the `nonce=null` pre-broadcast-failure case and made
> approval crash-safety (allowance re-check) explicit.
>
> **v3 changes (after 1st Codex review):** honest guarantee reframe (§2); **no rollback** on
> send failure; the `withNonce` callback does pre-broadcast durable recording (§3.1); all
> signer txs incl. approvals go through the allocator (§3.4); stuck-tx liveness deferred (§7).

## 1. Problem

The arbitrageur runs **two engines off one signer** — `ArbitrageEngine` and, opt-in,
`LiquidationEngine` — as **independent poll loops**. Each sources nonces independently
(liquidation: chain `pending` + local increment; arb: viem **auto-nonce**, *including its
per-vault approval*). Two nonce sources on one key ⇒ the same nonce goes to two txs, silently
dropping one. Exists today regardless of persistence (issue #6).

## 2. Guarantee (what this delivers — and what it does not)

**Delivered:**

- **G1 — no concurrent collision:** across arbitrary interleavings of the two engines, two
  in-flight sends **never** reserve the same nonce.
- **G2 — no-double-submit for a maybe-live tx:** a crash mid-submit **or an ambiguous send
  error** never causes the same *action* (position/vault) to execute twice. The intent stays
  **live** (in the reconcile set) until the chain resolves its reserved nonce, so it is not
  re-driven while its tx may be pending (persistence required).
- **G3 — best-effort reclaim:** a nonce whose tx was **not** broadcast is reclaimed (so we
  don't leak nonces) once the chain confirms it free.

**Explicitly NOT guaranteed here (deferred, §7):**

- **Gapless liveness under a stuck/dropped tx.** A broadcast tx that neither mines nor drops
  cleanly can stall higher nonces until reclaimed. Full handling (store the signed tx,
  re-broadcast the *same* nonce with a fee bump) is a separate execution-layer feature.
- **Absolute "never reuse a nonce"** against an **unreliable RPC**. If a managed/load-
  balanced `pending` read is stale, a nonce may be reused for a *different* action. The
  **worst case is a dropped action** (the chain accepts one tx; the other reverts or is
  replaced) — **not** fund loss or double-execution (the contract + a fresh `simulate` guard
  that). Ponder re-surfaces the missed opportunity next cycle. This residual is accepted for
  the single-instance cut.

**Assumptions:** one **active process** per signer (D4); each bot uses one `CLIENT_RPC_URL`.

## 3. Design

Nonce sequencing needs two things, **neither requiring persistence**:

| Concern | Mechanism |
|---|---|
| Two engines, one process | in-process **async mutex per signer** |
| Truth about the next nonce | **seed + re-seed from the chain** (`getTransactionCount(pending)`) |

Both sit behind one injected port, **`NonceAllocator`**, shared by both engines. The
persistence store is **orthogonal** — it provides **intent idempotency** (G2), not nonces:

- **No `DATABASE_URL`:** allocator runs (in-memory lease) → G1/G3 hold, engines coordinated.
  No intent tracking (G2 off).
- **`DATABASE_URL` set:** same allocator + intents around each send (G2 on).

### 3.1 API

```ts
// @repo/execution

export interface NonceAllocator {
  /**
   * Reserve the next nonce and run `send` under the per-signer lock.
   *
   * `send(nonce)` MUST, in order: (1) durably record the nonce if the caller tracks intents
   * (e.g. `transition(intent, "pending", { nonce })`) — this is REQUIRED before broadcast for
   * crash-safety — then (2) broadcast and return the tx hash. Keep it tight (no receipt wait):
   * it holds the signer lock.
   *
   * On throw, the outcome is treated as UNKNOWN (the tx may or may not have propagated): the
   * nonce is NOT reused this cycle, and the error propagates so the engine stops sending. The
   * next cycle's `resync` reclaims the nonce from the chain iff it is genuinely free.
   */
  withNonce<T>(send: (nonce: number) => Promise<T>): Promise<T>;

  /**
   * Re-align the lease to the chain's `pending` nonce (SET). `readChainNonce` is invoked
   * **inside** the lock — reading the chain outside and passing a value in would let a
   * concurrent `withNonce` advance the lease between the read and the SET, rewinding it
   * (a lost update). Called once at boot and at each cycle start. Advances if the chain moved
   * ahead; reclaims a not-broadcast nonce if the chain shows it free. Best-effort (§2 residual).
   */
  resync(readChainNonce: () => Promise<number>): Promise<void>;
}

/** Pluggable lease backend (in-memory now; DB-locked later, §7). */
export interface NonceLease {
  reserve(signer: Address): Promise<number>;   // return current, advance by 1
  set(signer: Address, value: number): Promise<void>;
}

export function createMemoryNonceLease(): NonceLease;                 // default (no persistence)
export function createNonceAllocator(lease: NonceLease, signer: Address): NonceAllocator;
```

Reference semantics — **no rollback**; the lock is a promise-chain covering reserve+send and
resync:

```ts
export function createNonceAllocator(lease: NonceLease, signer: Address): NonceAllocator {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});      // a rejection does not poison later sections
    return run;
  };
  return {
    withNonce(send) {
      return exclusive(async () => {
        const nonce = await lease.reserve(signer);   // monotonic; not rolled back on error
        return await send(nonce);                    // record-nonce + broadcast, under lock
      });
    },
    resync(readChainNonce) {
      return exclusive(async () => {
        // Read the chain WHILE holding the lock (no lost update vs a concurrent withNonce).
        await lease.set(signer, await readChainNonce());
      });
    },
  };
}
```

Why **no rollback:** because `send` throwing does **not** prove the tx wasn't broadcast (an
RPC timeout can fire after the node accepted the raw tx), and both engines simulate before
sending, so most late failures are *network* errors. Reusing that nonce would risk two txs
at one nonce. Instead we leave the lease advanced and let the **chain** adjudicate next cycle
(if `pending` didn't advance past the nonce, `resync` reclaims it).

### 3.2 Nonce lifecycle

- **Seed (boot):** `allocator.resync(chainPending)` once, before any send.
- **Re-seed (each cycle):** `allocator.resync(chainPending)` at the start of every `run()`.
- **Reserve (per send):** `lease.reserve` inside `withNonce`.
- **Reclaim:** implicit — next-cycle `resync` SETs the lease to `pending`, recovering any
  not-broadcast nonce; a `nonce too low` error triggers an immediate `resync` (Case B).
- **On any send error:** the engine **stops the cycle** (no further sends) and leaves the
  intent **live** (never terminal — see §3.4); next cycle re-seeds, **reconciles the live
  intent against the chain**, and re-drives.

### 3.3 Boot & cycle (per process)

`reconcilePending` runs **every cycle**, not only at boot — it is what resolves an intent
left live by an ambiguous send error (§3.4), by the reserved nonce vs. the chain: still in
the mempool ⇒ hold (don't re-drive); mined ⇒ terminal + re-drive against now-settled state;
never broadcast ⇒ terminal + re-drive.

```
create ONE NonceAllocator(lease, signer)          ← shared by both engines
allocator.resync(chainPending)                     ← seed once
ensureApproval() via the allocator                 ← approvals are signer txs too (§3.4)
start engine poll loops
  each run():
    [if store] reconcilePending(store, reader, signer)   ← resolve live intents (both actions)
    allocator.resync(chainPending)                       ← reclaim not-broadcast nonces
    send each tx via withNonce; break on error
```

### 3.4 Engine integration — **every signer tx** goes through the allocator

Both engines gain `nonces?: NonceAllocator` and (optional) `store?: StateStore`. When
`nonces` is present, **every** transaction the signer makes routes through `withNonce`:
liquidations, vault swaps, **and approvals** (`ensureApproval`/`approveMax`) — arb's approval
runs in-loop today and would otherwise collide.

- **send:** `hash = await nonces.withNonce(async (nonce) => { if (store) await store.transition(intentId, "pending", { nonce }); return writeContract({ …, nonce }); })`.
- **intents (only if `store`):** `recordIntent` (refuse duplicate live) *before* `withNonce`;
  on success `transition("submitted", { txHash })` (outside the lock); on receipts
  `transition(confirmed|failed)`.
- **On a send error, DO NOT terminalize the intent.** A thrown send is ambiguous (the tx may
  have propagated), so mark it `transition("submitted", { error })` — **live, with the
  reserved nonce, no hash** — and break the cycle. It stays in the reconcile set; the
  **next-cycle `reconcilePending`** decides by nonce vs. chain (mempool ⇒ hold; mined ⇒
  re-drive against settled state; not-broadcast ⇒ re-drive). Marking it `failed` here would
  let the next cycle re-drive the *same action* while its tx is still pending — the exact
  double-execution G2 forbids.
  - If the failure was **before broadcast** — `reserve` threw, or the pre-broadcast
    `transition` threw so no `writeContract` ran — the intent has **no reserved nonce**
    (`nonce = null`); `reconcilePending` treats that as *not broadcast* ⇒ terminal + re-drive
    (safe: no tx exists). This is the "pre-broadcast record failed" case; it needs no special
    path, it falls out of the nonce-vs-chain check.
- **Approvals** route through the allocator (for nonce ordering) but carry **no intent**;
  their crash/ambiguity safety is `ensureApproval`'s **allowance re-check** each run
  (idempotent: a landed approval ⇒ sufficient allowance ⇒ skip). Needs a nonce-aware approval
  helper (today's `approveMax` calls `writeContract` without a nonce).
- **cycle start:** `if (nonces) await nonces.resync(await nextNonce(publicClient, signer))`.

When `nonces` is absent, both engines keep today's exact behavior (liquidation local nonce;
arb auto-nonce).

## 4. Correctness (single instance)

`withNonce` and `resync` are **mutually exclusive** (same lock chain). Therefore:

1. **G1:** at most one reserved nonce is in flight at a time; `reserve` is monotonic ⇒ two
   concurrent sends never share a nonce.
2. **No same-cycle reuse:** a failed send does not roll back, so its nonce is not handed out
   again until a `resync` proves it free.
3. **G3 (reclaim) is chain-adjudicated:** only `resync` (SET to `pending`, under the lock,
   no reserve outstanding) can lower the lease, and only to a nonce the chain reports free.
4. **G2 (crash / ambiguous send):** the reserved nonce is persisted to the intent *before*
   broadcast (§3.1) and the intent is **kept live** on a send error (§3.4), so
   `reconcilePending` — run every cycle — resolves it by hash or reserved nonce vs. chain and
   never re-drives an action whose tx may be pending. The chain re-seeds the lease with no
   persisted counter.

**Residual (accepted):** step 3 trusts `pending`. If a managed RPC returns a stale `pending`,
`resync` can reclaim a nonce whose tx is actually live → that nonce is reused for a different
action → one tx wins, the other reverts/replaces → a **dropped action**, self-correcting
(§2). No double-execution.

### The interleaving the mutex kills

Lease 10, no serialization: Liq reserves 10 (sending), Arb reserves 11 (sending), Liq's 10
errors; without the lock a naive reclaim could hand 10/11 out again mid-flight and collide.
Under the lock, no reclaim or reserve runs until the in-flight section settles, and reclaim
only happens at cycle boundaries from the chain — never mid-flight.

## 5. Failure cases

| Case | Scenario | Handling | Guarantee |
|---|---|---|---|
| A | send throws, tx **not** broadcast | intent kept live (nonce, no hash); next-cycle reconcile sees `pending == nonce` ⇒ terminal + re-drive; `resync` reclaims nonce | G2, G3 |
| A' | send throws, tx **maybe** broadcast (ambiguous) | intent kept live; next-cycle reconcile: mempool ⇒ hold, mined ⇒ re-drive on settled state, (stale `pending`) not-seen ⇒ §2 residual | G2 |
| A'' | pre-broadcast failure (`reserve`/`transition` threw, no `writeContract`) | intent has `nonce = null` ⇒ reconcile treats as not-broadcast ⇒ terminal + re-drive (no tx exists) | G2 |
| B | `nonce too low` (chain ahead) | immediate `resync` advances the lease; break cycle | G1 |
| C | tx broadcast then dropped | reclaimed once `pending` shows it free; until then higher nonces may queue | best-effort (§7) |
| D | post-broadcast bookkeeping/receipt error | never marks intent `failed`; stays live for reconcile | G2 |
| E | two engines interleave | mutex serializes reserve + resync | G1 |
| F | crash/restart | boot `resync` from chain; intents reconcile (if store) | G2 |
| G | approval tx | routed through `withNonce`; no intent — allowance re-check is the idempotency guard | G1 |

## 6. Testing

- **Allocator unit** (`@repo/execution`): N concurrent `withNonce` → gapless, duplicate-free;
  a throwing `send` does **not** reuse the nonce for the next call; `resync` interleaved with
  `withNonce` only changes the lease at boundaries; `resync` to a lower `pending` reclaims.
- **Engine concurrency** (`@repo/engine`): both engines through one shared allocator with
  interleaved sends + a mid-batch failure ⇒ union of nonces gapless, no reuse; a send error
  stops the cycle **and leaves the intent live (not `failed`)**.
- **Ambiguous-send no-double-submit:** send throws after (mocked) broadcast ⇒ intent stays
  live ⇒ next cycle, with the reserved nonce still in `pending`, reconcile **holds** (no
  re-drive); once the nonce is mined, reconcile allows re-drive. A `nonce=null` (pre-broadcast
  failure) intent is re-driven immediately.
- **Approval path:** arb `ensureApproval` routes through the allocator (no auto-nonce); a
  landed-but-ambiguous approval is skipped next run via the allowance check.
- **Regression:** Phase-D crash-safety tests updated (allocator injected; per-cycle reconcile;
  seed via `resync`).

## 7. Deferred (future issues)

- **Stuck-tx liveness:** persist signed txs; detect stuck/dropped; re-broadcast the same
  nonce with a fee bump (never reuse for a different action). Removes the Case-C/A' residual.
  Overlaps #21 (private relay) fee management. Tracked separately.
- **Multi-process:** swap the in-memory `NonceLease` for a DB row/advisory-lock lease
  (Phase-D `reserveNonce`/`syncNonce` are the dormant seam) and gate `resync` behind the
  lease owner. `NonceAllocator` API unchanged.
- **Broadcast-timeout liveness:** a hung `writeContract` holds the signer lock and starves
  both engines. A safe timeout needs the stuck-tx machinery above (a timed-out broadcast is
  ambiguous), so it lands with that work.

## 8. Decisions

1. **Scope:** single instance; guarantees G1–G3 (§2), residual accepted. ✔
2. **Send failure:** **no rollback**, and **keep the intent live** (not `failed`) — the nonce
   is reclaimed and the intent resolved by the **per-cycle** `reconcilePending` from the
   chain. ✔ (review Q + v4)
3. **Stuck-tx liveness:** **deferred** to a future issue (§7). ✔ (review Q)
4. **Lease home:** in-memory, chain is truth; Postgres lease dormant (multi-process seam). ✔
5. **Lock scope:** record-nonce + broadcast + resync under the lock; receipt waits outside. ✔
6. **All signer txs** (incl. approvals) go through the allocator. ✔
7. **Arb intent fields:** `action="vault-acquisition"`, `subject=vaultId`, `target=VaultSwap`. ✔
8. **#6** resolved here; stuck-tx + multi-process tracked as follow-ups (§7). ✔
```
