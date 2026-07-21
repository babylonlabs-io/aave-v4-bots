# Issue breakdown — remaining production-safety + contracts work

Everything designed this cycle but **not yet implemented**, split into GitHub-ready
issues sized for one owner each. Grouped by readiness so multiple devs can start in
parallel. Source of truth per issue is linked (refactor-002 plan, RFC-001 addenda).

Baseline today: `@repo/{abis,capital,chain,config,domain,engine,execution,logger,metrics,observability,risk}`,
`@services/{liquidator,arbitrageur,ponder}`. Phase A (arbitrageur runs both engines) and
Phase B (`@repo/risk` core) are **done**.

## Parallelization at a glance

```
Bots/TS track — ready now (independent, grab any):
  #1 signer/secrets ─┐
  #2 persistence ────┼─────────────▶ #9 modes+notifications (needs #1 & #2)
  #3 risk guards
  #4 risk wiring / kill-switch
  #5 engine → risk data
  #6 dual-engine nonce manager
  #7 e2e CI validation
  #10 dependency-boundary rules (scaffold now, finalize after #1/#2/#9)

Contracts track (RFC-001):
  #8 RFC consolidation ─▶ #13 scaffolding + shared primitives ─┬─▶ #14 Router core (self-funded) ─┐
                                                               ├─▶ #15 VenueManager base ──────────┼─▶ #16 Router flash paths
                                                               └─▶ #17 LiquidationRelayer            │
  #18 off-chain flash-venues selector (TS, parallel) ───────────────────────────────────────────────┘
  #19 contracts testing + audit prep (as #14–#17 land)
  #14 deployed ─▶ #12 drop bufferAmounts (engine)
  #9 ─▶ #20a operator-cli v1 (EOA + Safe)     ;  #20a + #17 ─▶ #20b (batch/relayer render)
```

- **Up to ~8 issues can start immediately** (#1–#8). #9/#11/#12 are blocked; #10 can
  scaffold anytime.
- **Coordinate**: #3 and #4 share the `RiskConfig` shape; #1 and #6 both touch
  `@repo/execution`'s send path — pair or sequence those two if the same person isn't on
  both.

---

# Ready to start (parallel)

## #1 — feat(signer): `@repo/signer` + `@repo/secrets` (refactor-002 Phase C)  ✅ DONE
**Labels:** `enhancement`, `package`, `security` · **Effort:** ~3–5d · **Blocks:** #9

**Context:** Today the private key lives in plaintext `.env` and the engine signs via a
viem `WalletClient`. Introduce a `Signer` port so the key never enters `@repo/engine` and
KMS/HSM is a later drop-in. See `docs/refactor-002-production-safety-plan.md` §Phase C,
decision **D5**.

**Scope:**
- [x] `@repo/signer`: `Signer { address; account }` (modelled as a viem `Account`) + `Submitter { send(serialized, policy): Hex }` ports.
- [x] `./local` signer (`privateKeyToAccount`, **behavior-preserving**); `./aws` KMS signer (real adapter — see #25).
- [x] `Submitter ./public` = current broadcast (`sendRawTransaction`).
- [x] `@repo/secrets`: `SecretsProvider { get(ref): Promise<string> }` + `createEnvSecrets` (today's env) + `createAwsSecrets` stub. (Key lives in `signer`, not `secrets`.)
- [x] Services resolve the key via `secrets.get(<REF>) → createLocalSigner` and build the `WalletClient` with `signer.account`; key removed from `@repo/config`.
- [x] **D5 decided:** keep AUTO-local on viem's machinery; the explicit `sign`→`send` split is deferred to #21 (private-relay), the first place it's needed. See plan §Phase C / D5.

**Acceptance:** ✅ send path behaves identically with `./local` + `./public`; `@repo/engine`
no longer imports the wallet key; typecheck + biome + tests green; unit tests for the local signer/submitter (signer 4, secrets 4).

> **Note (carried to #21):** the `@repo/execution` `submit(intent)` refactor (engine builds a `TxIntent` instead of calling `writeContract`) is intentionally **not** part of #1 — it buys nothing while the only submitter is `./public`. It lands with the private-relay `Submitter` in #21, which is where a non-default broadcast path forces the sign→send seam onto the hot path.

---

## #2 — feat(persistence): `@repo/persistence` StateStore + crash-safety (Phase D)
**Labels:** `enhancement`, `package`, `reliability` · **Effort:** ~4–6d · **Blocks:** #9

**Context:** No persistence today → a crash mid-submit can double-submit. Add a `StateStore`
with idempotency keys + nonce leases + boot reconcile. See plan §Phase D, decisions **D3/D4**.

**Scope:**
- [ ] `@repo/persistence`: `StateStore { reserveNonce(addr); recordIntent(i); transition(id,to,meta?); reconcile() }`.
- [ ] `./memory` (dev/tests) + `./postgres` (prod) adapters (decide **D3** for the first backend).
- [ ] Thread `recordIntent(pending) → transition(submitted/confirmed/failed)` around the submit path; `reserveNonce` replaces the in-loop `nextNonce` for persisted sequencing.
- [ ] `reconcile()` on boot resolves pending/submitted intents against the chain **before** re-submitting.
- [ ] Idempotency key per `(chainId, target, action, subject)`; refuse a second live `recordIntent`; decide **D4** (single-instance vs leasing).

**Acceptance:** a test harness that kills the process mid-submit → restart re-drives with
**no duplicate tx**; nonce sequence survives restart; unit tests for `./memory`; green.

---

## #3 — feat(risk): exposure-cap + code-hash guards (Phase B follow-up)  ✅ DONE
**Labels:** `enhancement`, `risk`, `security` · **Effort:** ~2–3d

**Context:** `@repo/risk` shipped with kill-switch + breaker + profit-floor + freshness.
Two guards were deferred because they need state/IO. See plan §Phase B "Deferred".

**Scope:**
- [x] **Exposure cap:** `maxInFlight` in `RiskConfig`; the gate blocks once that many actions are in flight.
- [x] **Leak case:** made unrepresentable. `RiskGate.openSlot(action)` is the *only* way to ask the gate, and it returns a `RiskSlot` that is the only way to release the exposure it reserved (`check`/`recordOutcome` are no longer public). `settle()` is idempotent, so an engine settles on the precise exit path and again in a `finally` backstop, and only the first wins. New `ActionOutcome.abandoned` releases the slot for pre-broadcast bailouts (duplicate intent, gas-estimate revert) **without** feeding the consecutive-failure breaker.
- [x] **Code-hash guard:** `RiskGate.verifyCode(read)` + `startCodeHashGuard()` (boot check, then every `RISK_CODE_CHECK_INTERVAL_MS`). A mismatch or missing code ⇒ `HALTED`. A *probe* failure is handled asymmetrically: at boot it **halts** (nothing has ever been verified, so the first tx must not go out), afterwards it does not (an RPC blip is not evidence of compromise) — the next tick retries. `@repo/risk` stays dependency-free: it takes a plain per-address read *function*, and `@repo/chain`'s `readCodeHash(client, address)` supplies it. Reads are **not** batched — a mismatch anywhere outranks a probe failure everywhere, so one unreadable address can never mask an upgraded contract at another.
- [x] Extended `RiskConfig`; unit tests for in-flight accounting, abandoned outcomes, floor-at-zero, resume-clears-count, and mismatch/no-code/probe-failure.

**Acceptance:** ✅ unit tests cover exposure cap + code-hash halt; permissive config unchanged
(a deployment setting no `RISK_*` var gets today's never-blocks/never-halts gate); green.

**One deliberate semantic change:** an outcome is now tied strictly to an allowed `openSlot`.
A throw *before* the gate is consulted (Ponder fetch, preview read) no longer counts toward the
breaker — it holds no slot to release, and it is an infrastructure error rather than a failed
action. Those still surface through `metrics.recordError`.

---

## #4 — feat(risk): env-driven thresholds + shared kill-switch (Phase B follow-up)  ✅ DONE
**Labels:** `enhancement`, `risk`, `services` · **Effort:** ~2–4d · **Coordinate:** #3 (RiskConfig shape)

**Context:** Services inject a **permissive** gate today. Wire real thresholds from env and a
single per-process gate with a kill-switch trigger. Decisions **D1** (trigger) / **D2** (scope).

**Scope:**
- [x] `RISK_*` env → `RiskConfig` via `@repo/config` (`riskEnvFields` + `buildRiskConfig`), shared by both services. Every field optional; unset ⇒ that guard is off.
- [x] One **shared** `RiskGate` per process, injected into every engine. *(This fixed a live defect: the arbitrageur constructed two independent gates, so halting one left the other trading.)*
- [x] **D1 = authenticated control endpoint.** `@repo/risk` owns the remote kill switch (module map §5.6) end to end: routes, auth, and its **own HTTP server**, started by `startRiskRuntime` when `RISK_CONTROL_TOKEN_REF` is set. `POST /halt`, `POST /resume`, `GET /status`, bearer token, constant-time compare, `POST`-only for the mutating routes, never echoed in a response; the token is a *secret reference* resolved through `@repo/secrets` at boot, exactly like the signing key. Unset ⇒ no control server is started at all.
  - **Separate socket, loopback by default** (`RISK_CONTROL_PORT` 9095, `RISK_CONTROL_HOST` 127.0.0.1). `/metrics` must be scrapeable from the cluster; a route that can stop production trading must not share that exposure decision. `@repo/observability` has no knowledge of the kill switch, and a test asserts the metrics server 404s `/halt`.
  - `RISK_START_HALTED=true` **requires** `RISK_CONTROL_TOKEN_REF`, rejected at startup otherwise: a breaker trip or a boot-probe halt clears on restart, but booting halted with no `/resume` bricks the bot on every restart.
- [x] **D2 = per-process for now.** A multi-process shared halt belongs in the `StateStore` (#2) and is deferred; one bot process today owns one signer.

**Acceptance:** ✅ `dualEngine.test.ts` proves the shared gate: halting it stops **both** engines,
a gate booted `startHalted` trades nothing until resumed, a breaker tripped by liquidation failures
halts arbitrage, and the exposure cap counts across engines. `packages/config/src/risk.test.ts`
proves the no-`RISK_*`-vars default leaves every guard unconfigured. Typecheck + biome + tests green.

---

## #5 — feat(engine): feed profit/freshness into the risk gate (Phase B follow-up)  ✅ DONE (with one carried gap → #27)
**Labels:** `enhancement`, `engine`, `risk` · **Effort:** ~1–2d

**Context:** The per-candidate `risk.check(...)` was wired but only passed `{kind, subject}`, so
the profit-floor + freshness guards never fired. See plan §Phase B "Deferred".

**Scope:**
- [x] **Arb `expectedProfit`** — exact, no oracle needed, and **conservative**:
  `expectedProfit = preview.amountVault − maxWbtcIn`, computed at the `openSlot()` site.
  It floors on the **worst case the tx authorizes**, not the optimistic preview cost:
  `swapWbtcForVault` charges the debt+fee prevailing at execution and only reverts *above*
  `maxWbtcIn`, so interest accruing between preview and execution can eat the margin while the
  tx still succeeds. (Flooring on the un-slipped `amountWbtcToAcquire` would wrongly allow that —
  a regression test locks this in.)
- [ ] ~~Liquidation `expectedProfit` from the Lens estimate~~ — **not possible today; carried to #27.**
  The issue's premise was wrong: `estimateLiquidation` returns `[amounts (debt-token units),
  wbtcPayment, vaults (bytes32 *ids*)]`, and `liquidate`/`liquidateWithLLP` return only
  `vaultIds` — so neither the estimate nor a simulation yields a WBTC-denominated profit.
  The engine therefore passes **no** `expectedProfit` for liquidations; the gate skips the floor
  when it's `undefined` (explicit, not a silent hole), and a test locks that in.
- [x] **`dataTimestampMs`** — both Ponder endpoints now return the **chain-block timestamp their
  live reads were evaluated at** (`readBlockTimestampMs`). Deliberately *not* `Date.now()` at
  response time, which would make the guard a permanent no-op (a stuck indexer still answers
  "now"). This catches a lagging/stale RPC behind the indexer. Indexer **head** lag remains #23's
  guard. Note this means a **stalled chain blocks everything** once the bound is configured —
  that is the intended chain/RPC liveness semantics.
- [x] **Freshness is fail-closed** (`@repo/risk`): if `maxDataStalenessMs` is configured but the
  action carries no `dataTimestampMs` (old indexer, or a failed block probe), the gate **blocks**
  rather than silently trading on data of unknown age. Asymmetric with the profit floor, which
  still *skips* on a missing `expectedProfit` — deliberately, since fail-closing there would
  disable every liquidation the moment an operator sets a floor (see #27). Unconfigured guards
  are unaffected, so the default permissive gate behaves exactly as before.
- [x] Engine tests: `minProfit` blocks a below-floor vault; `maxDataStalenessMs` blocks a stale
  candidate (both with positive controls); plus the "no timestamp ⇒ guard skipped" and the
  "liquidation profit floor cannot bite" cases.

**Acceptance:** ✅ engine tests prove the profit (arb) + freshness (both) guards bite via
`openSlot()`; engine tests green.

---

## #6 — feat(execution): shared nonce manager for the dual-engine bot
**Labels:** `enhancement`, `execution`, `reliability` · **Effort:** ~2–3d · **Coordinate:** #1, **overlaps #2**

**Context:** The arbitrageur now runs two engines off one signer; their concurrent sends can
collide on nonces (liquidation manages nonces explicitly, arb uses viem auto-nonce). Surfaced
in the e2e note. A per-key nonce coordinator serializes/allocates nonces across engines.

> **Coupling with #2:** #2's `reserveNonce` is the *persisted* nonce authority. #6 is the
> **in-process tactical bridge** to unblock the dual-engine bot before #2 lands — it is **not**
> a second independent authority. Decide up front: either (a) #6 is a thin interface #2 later
> implements durably, or (b) fold #6 into #2 and accept the arbitrageur waits for #2. Do **not**
> ship two competing nonce owners.

**Scope:**
- [ ] A per-address nonce authority in `@repo/execution` (allocate/commit/rollback), pending-aware, safe across concurrent callers in one process.
- [ ] Both engines route sends through it (replaces ad-hoc `nextNonce` + auto-nonce).
- [ ] Unit tests: interleaved allocations don't reuse a nonce; failure re-syncs.

**Acceptance:** a concurrency test (two engines, shared signer) produces a gapless nonce
sequence with no reuse; green. (Dovetails with #1's submit path — sequence or pair.)

---

## #7 — test(e2e): validate the two-suite split in CI + fix compile/type issues
**Labels:** `test`, `e2e`, `ci` · **Effort:** ~1–3d

**Context:** The e2e was split into an **arbitrageur suite (one bot, both engines)** and a
**liquidator suite** (matrix in `.github/workflows/e2e-tests.yml`). It's **unverified** — the
`contracts` submodule (private) isn't available locally, so nothing beyond `forge fmt` ran.

**Scope:**
- [ ] Run both matrix legs in CI (submodule checked out); fix compile/type issues the real `BaseE2E`/`test-utils` surface (member names, `getPosition().proxyContract`, signatures).
- [ ] Confirm the arb suite's unified Ponder serves both `/liquidatable-positions` and `/escrowed-vaults`, and the arb bot's `LiquidationEngine` clears the position → the `ArbitrageEngine` acquires the vault.
- [ ] Confirm the liquidator suite still passes standalone.
- [ ] Watch for the **dual-engine nonce flake** (see #6) — if it flakes, that's the fix.

**Acceptance:** both CI matrix legs green; logs show liquidation + acquisition for the arb suite.

---

## #8 — docs(rfc-001): consolidate the three addenda into the base RFC
**Labels:** `docs`, `rfc` · **Effort:** ~1d · **Blocks:** #11

**Context:** Three "proposed diffs" addenda are **not yet applied** to
`docs/rfc-001-liquidation-contracts.md`: `flash-venues`, `venue-manager`, `order-slippage`.

**Scope:**
- [ ] Apply the diffs from `rfc-001-flash-venues-addendum.md`, `rfc-001-venue-manager-addendum.md`, `rfc-001-order-slippage-addendum.md` into the base RFC (in that order — each builds on the prior).
- [ ] Resolve the carried open items: adapter-native vs router-side `maxRepayAmount` clamp (verify against `vault-contracts-aave-v4`); `VenueManager` naming; flash borrow-sizing.
- [ ] Fold the addenda into the base (or keep as an appendix) and mark them applied.

**Acceptance:** RFC-001 reads as one coherent spec (VenueManager base, `maxRepayAmount` on `Order` + `Intent`, multi-venue flash); open items either resolved or explicitly listed.

---

# Blocked (start after dependencies)

## #9 — [epic] MANUAL/AUTO execution modes + `@repo/notifications` (Phase E)
**Labels:** `epic`, `enhancement`, `services` · **Depends on:** #1, #2 · **Design:** `docs/design-009-execution-modes-and-notifications.md`

**Split into #9a / #9b / #9c** — the original single issue was too large to land safely. The design
doc is the source of truth; the short version of *why* it is bigger than it looks:

**MANUAL is keyless.** A MANUAL bot never signs, so it needs no private key, no KMS, no
`WalletClient`, no nonce and no `TxSender` — only the *address* that will broadcast. That is the
security prize (no hot key to steal), and it means MANUAL is not a flag on the send path but a
**separate lifecycle**. A proposal is not a transaction: it must be live for idempotency (or every
cycle re-notifies) yet invisible to reconcile (it has no tx), which is one set that currently does
both jobs.

### #9a — feat(persistence): the proposal lifecycle
**Effort:** ~2–3d · No engine changes; unit-testable alone.
- [ ] `proposed` / `superseded` / `expired` statuses; `payload` + `payload_hash` columns on `tx_intents`.
- [ ] Split the dedup set from the reconcile work-list (`LIVE_FOR_DEDUP` vs `IN_FLIGHT_ON_CHAIN`); **fix the hardcoded revive set in `postgres.ts`** — omit `expired` there and an expired proposal blocks its subject forever.
- [ ] Guarded `markBroadcast` (compare-and-set + payload match + on-chain verify); `supersede`; `expire`.

**Acceptance:** dedup blocks a second proposal; expired/superseded revive; `markBroadcast` rejects a mismatched hash; proposals never appear in the reconcile work-list.

### #9b — feat(engine,services): keyless MANUAL execution
**Effort:** ~4–6d · **Depends on:** #9a. The load-bearing one.
- [ ] `ExecutionIdentity {from, chainId}` replaces the `walletClient.account.address` / `.chain.id` uses; `Executor` seam (`createAutoExecutor` / `createManualExecutor`).
- [ ] Approvals become proposals (`ensureApproval` broadcasts today — a keyless bot cannot). Key must be `target=spender, subject=token`, and the check moves **before** `openSlot` or the arbitrage risk slot leaks.
- [ ] Lazy nonce reads in `reconcilePending`; inert nonce path in `CrashSafety` under MANUAL.
- [ ] Services boot keyless in MANUAL; `EXECUTION_MODE` + `MANUAL_EXECUTOR_ADDRESS`.
- [ ] Stage: identity → liquidation engine → arbitrage engine.

**Acceptance:** a MANUAL service starts with **no key configured** and constructs no `WalletClient`/`TxSender`/`NonceAllocator`; MANUAL persists + notifies + broadcasts nothing; **every existing AUTO test passes unchanged**.

### #9c — feat(notifications): `@repo/notifications` + risk alerts
**Effort:** ~2–3d · Independent — **can land first**, and is useful on its own (breaker/kill-switch alerts have value in AUTO today).
- [ ] `Notifier { notify(event) }` + `./slack` (webhook URL as a *secret reference*) + `./noop`.
- [ ] Log-always discipline: a notifier failure is logged and swallowed, never breaks a cycle.
- [ ] `RiskConfig.onEvent` callback (keeps `@repo/risk` dependency-free) wired to the notifier in `startRiskRuntime`; MANUAL pending-intent + `intent-stuck` alerts.

**Acceptance:** a halt emits an alert; a notifier failure never breaks a cycle; unset ⇒ no-op.

> **Deferred to `operator-cli` (#20a), now scoped:** `markBroadcast`'s caller, plus Safe operator
> support — a Safe's `execTransaction` receipt succeeding does not mean the inner call did, so #20a
> reconciles Safe intents by the `ExecutionSuccess`/`ExecutionFailure` event, not receipt status. See
> `docs/design-020-operator-cli-v1.md`.

## #10 — chore(boundaries): enforce dependency-boundary rules (Phase F)
**Labels:** `chore`, `tooling` · **Effort:** ~1–2d · **Best after:** #1, #2, #9 exist

**Scope:**
- [ ] biome/import-restriction rules so `@repo/engine` (and other core pkgs) can't import an adapter or an SDK (`aws-sdk`/`pg`/`prom-client`).
- [ ] Confirm no SDK leaks into core packages; tighten to proposal §3.4.
- [ ] **Assert `@repo/shared` is fully gone** — no workspace/package/import references remain (it's already deleted; this locks it). Do **not** open a separate issue for the deletion.

**Acceptance:** a violating import fails lint in CI; no `@repo/shared` references anywhere; existing tree passes.

---

# Contracts track — RFC-001 (`LiquidatorRouter`, `VenueManager`, `LiquidationRelayer`)

> **Decision D6 — repo/home:** do the new Solidity contracts live in `vault-contracts-aave-v4`
> (alongside `AaveAdapter`/`VaultSwap`, reusing its test harness) or a new contracts area in
> this repo? Settle this in the epic before #13. The RFC + the off-chain selector (#18) + the
> coupling (#12) stay in this repo regardless.

## #11 — [epic] Implement the RFC-001 liquidation contracts
**Labels:** `epic`, `contracts` · **Depends on:** #8 · **Effort:** large (tracks #13–#17, #20b + audit)

Tracking issue for the on-chain deliverables of RFC-001 (consolidated in #8). Batches the
sub-issues below, records D6, and owns the audit milestone. After #13 (scaffolding), **#14,
#15, and #17 run in parallel**; #16 joins them; #18 (TS) runs anytime.

## #13 — contracts: architecture spike + accounting/approval core (the parallelism gate)
**Labels:** `contracts`, `foundation`, `spike` · **Depends on:** #8, D6, D9 · **Effort:** ~3–5d · **Blocks:** #14, #15, #16, #17

> **This is not just "scaffolding" — it pins the security-critical core that #14/#15/#17 all
> assume, so they can only truly parallelize *after* this lands.** Under-scoping it means churn.

**Scope:**
- [ ] Project setup per D6; shared types: `Order { borrower, maxRepayAmount, maxFairnessWbtc, minWbtcOut }`, `SwapParams`, `ProfitGuard { minWbtcProfit }`, `Venue` enum.
- [ ] **`maxRepayAmount` on-chain clamp** — resolve current debt on-chain and repay `min(currentDebt, maxRepayAmount)`; **decide adapter-native vs router-side read (D9)** — verify against `vault-contracts-aave-v4`.
- [ ] Order → adapter positional calldata builder (single-token / multi-reserve scalar-vs-array — D9); WBTC-delta profit guard (snapshot in/out; gas basis for `minWbtcProfit` — D9).
- [ ] **Access-control base + event schema** (owner/operator, allowlists, capped approvals, active-execution lockout) that #14/#15/#17 share.

**Acceptance:** primitives + access base compile with unit tests (clamp math, guard delta, calldata builder); the accounting/access/event interfaces are frozen so #14/#15/#17 can proceed without churn.

## #14 — contracts: `LiquidatorRouter` — self-funded core
**Labels:** `contracts` · **Depends on:** #13 · **Effort:** ~4–6d · **Parallel with:** #15, #17 · **Blocks:** #16, #12

**Scope:**
- [ ] Immutables/config (adapter, llp, wbtc), owner (Safe) / operator access, `assetAllowlist`/`venueAllowlist`, `approvalCaps`, rescue locked during active execution.
- [ ] `batchLiquidate(debtAsset, orders, allowFailure, profitGuard)` — self-funded; repay `min(currentDebt, maxRepayAmount)` per item.
- [ ] `ProfitGuard` enforcement (WBTC delta) + debt-spend bound (§3.6) + per-item bounds.
- [ ] Invariants (RFC §3.6) as tests.

**Acceptance:** self-funded batch liquidations pass fork tests; guard reverts an unprofitable batch; green.

## #15 — contracts: `VenueManager` abstract base (flash sourcing)
**Labels:** `contracts`, `security` · **Depends on:** #13 · **Effort:** ~5–7d · **Parallel with:** #14, #17 · **Blocks:** #16

**Context:** per `rfc-001-venue-manager-addendum.md` — abstract base (not a separate deployment;
funds never leave the router).

**Scope:**
- [ ] Active-flash context struct `{kind, lenderOrPool, borrowAsset, amount, repayAsset, owed, dataHash}` in transient storage (also the single-flash guard).
- [ ] `_flashLoan(venue, asset, amount, data)` / `_flashSwap(feeTier, asset, amount, maxWbtcRepay, data)` initiators; UniV3 pool derivation from the immutable factory.
- [ ] The 4 native callbacks (Aave/Balancer/Morpho + `uniswapV3SwapCallback`), each authenticating `msg.sender == active.lenderOrPool`; **base owns `owed` + repay + guard-after-repay**; `_onFlashFunds` hook returns nothing (hook only leaves ≥ owed).
- [ ] Per-venue repay mechanic (approve-back / transfer-back / pay-pool-in-WBTC).

**Acceptance:** each venue callback authenticates + repays correctly against a mock lender/pool; fake-pool + stray-callback revert; green.

## #16 — contracts: `LiquidatorRouter` — flash paths
**Labels:** `contracts` · **Depends on:** #14, #15, **the flash-borrow-sizing decision** (order-slippage addendum open item — resolve in #8/#13, not just "spec") · **Effort:** ~3–4d

**Scope:**
- [ ] `flashLiquidate(debtAsset, venue, orders, …, fairnessSwap, repaySwap)` (loan mode) and `flashSwapLiquidate(debtAsset, feeTier, maxWbtcRepay, orders, …, fairnessSwap)` (swap mode).
- [ ] Router's `_onFlashFunds` override: fairness pre-swap → batch → (loan) repaySwap → leave ≥ owed.
- [ ] Borrow-amount derivation (`sum(maxRepayAmount) + fairnessSwap.maxIn`), profit guard as the premium backstop (no `maxPremium`).

**Acceptance:** flash-loan + flash-swap liquidations pass fork tests across the enabled venues; guard/repay-or-revert hold; green.

## #17 — contracts: `LiquidationRelayer` (Model A)
**Labels:** `contracts` · **Depends on:** #13 · **Effort:** ~4–6d · **Parallel with:** #14, #15 · **Blocks:** #20b (not #20a)

**Scope:**
- [ ] Config; per-`(provider, asset)` `AssetPolicy { maxPerPosition, minWbtcProfit, maxFeePerGas, expiry }` via `setPolicy`/`revokePolicy`; allowance-as-cap.
- [ ] `Intent { provider, borrower, debtAsset, maxRepayAmount, deadlineBlock }`; enforcement: policy active, deadline, gas ceiling, `pulled = min(currentDebt, maxRepayAmount) ≤ maxPerPosition ≤ allowance`, absolute `minWbtcProfit`.
- [ ] Invariants (RFC §4.8) as tests. (Safe-module variant §4.7 deferred.)

**Acceptance:** relayer executes an intent, proceeds land at the provider, over-cap/expired/no-policy revert; green.

## #18 — feat: off-chain flash-venues selector (TS, this repo)
**Labels:** `enhancement`, `package` · **Depends on:** #8 (spec) · **Effort:** ~2–3d · **Parallel** (feeds #16)

**Scope:**
- [ ] `flash-venues` module (per `rfc-001-flash-venues-addendum.md`): one source per venue implementing `quote(asset, amount) → { available, costBps, liquidity }`; a factory + a `domain` route planner ranking by lowest all-in cost meeting the size.
- [ ] Emit `(venue)` for a flash loan or `(feeTier, maxWbtcRepay)` for a flash swap; the on-chain guard is the authority (quote only).

**Acceptance:** unit tests rank venues + pick the cheapest meeting size; no on-chain dependency; green.

## #19 — test: contracts integration + invariant/fuzz + audit prep
**Labels:** `test`, `contracts`, `security` · **Depends on:** #14–#17 (incrementally) · **Effort:** ongoing

**Scope:**
- [ ] Fork/integration tests per venue + the relayer; invariant/fuzz on the profit guard, debt-spend bound, repay-or-revert, callback auth, `maxRepayAmount` clamp.
- [ ] **Fee-on-transfer / rebasing token rejection** and **bundle/trace simulation** (not just `eth_call`) — RFC §6.
- [ ] Audit-scope doc (native per-venue handlers, custody model, allowlist trust assumptions).

**Acceptance:** invariant suite green; fee-on-transfer rejected; a trace/bundle sim path exists; audit scope reviewed.

# Additional issues (completeness — from the architecture proposal / reorg Phase 7–9)

> These close the gaps a review found between this breakdown and
> `docs/production-architecture-proposal.md` §5 + `docs/refactor-001-repo-reorg-plan.md`
> Phase 7/8/9. Several are *deferred* (post-contracts / hardening) but must be **tracked**,
> not implicit.

## #21 — feat(execution): `Submitter ./private-relay` (Flashbots / MEV-Blocker)
**Labels:** `enhancement`, `execution`, `mev` · **Depends on:** #1 (Submitter port) · **Effort:** ~2–4d

**Context:** Proposal §5.7 / §9 treat private-relay broadcast as **L0 / table-stakes** for a
permissionless liquidator (alpha leak + front-running). #1 ships only `./public`; this must
**not** be buried there.

**Scope:**
- [ ] **Land the deferred #1 seam:** refactor `@repo/execution` to a `submit(intent)` that assembles → `signer.signTransaction` → `submitter.send`; engine builds a `TxIntent` instead of calling `writeContract`. (#1 kept AUTO-local on viem's `writeContract` because `./public` needed nothing more — this issue is the first to require an explicit sign→send split.)
- [ ] `Submitter ./private-relay`: Flashbots Protect / MEV-Blocker endpoint config, **revert protection**, public fallback, profit-capped priority fees.
- [ ] Selectable per-mode via `SubmitPolicy` (AUTO default = private relay).

**Acceptance:** liquidations broadcast through the private relay with a public fallback path; fee cap honored; local/public path still behaves identically; green.

## #22 — feat: RELAYER execution mode + relayer route planner (bot-side)
**Labels:** `enhancement`, `execution`, `services` · **Depends on:** #17 (relayer contract), #21 · **Effort:** ~3–5d

**Context:** #17 builds the `LiquidationRelayer` *contract*; nothing on the **bot** selects
relayer intents, validates provider policy/allowance, submits via private relay, and accounts
provider proceeds. Refactor-002 defers "RELAYER mode + private relay" after contracts.

**Scope:**
- [ ] `execution` RELAYER mode; a route planner that picks eligible `(provider, debtAsset)` intents under live policy/allowance/`minWbtcProfit`.
- [ ] Build + submit `Intent[]` via #21; account proceeds landing at the provider.

**Acceptance:** bot drives a relayer liquidation end-to-end against #17 on a fork; green.

## #23 — feat(indexer): `@repo/indexer` port + liveness hardening (proposal §5.5 / reorg Phase 7)
**Labels:** `enhancement`, `package`, `reliability` · **Effort:** ~3–5d · **Coordinate:** #5, #4

**Context:** The Ponder indexer is today an **unguarded source of truth**. Abstract it behind an
`OpportunitySource`/indexer port and add liveness guards.

**Scope:**
- [ ] `@repo/indexer` port (`liquidatable()`, `escrowedVaults()`); Ponder adapter; optional direct-event fallback.
- [ ] **Indexed-head lag guard** (stale head → risk `HALTED`/degraded via #4), RPC-vs-indexer disagreement check, reorg policy, watchdog heartbeat.
- [ ] Emit the `dataTimestampMs` #5 needs (or coordinate so #5 consumes it).

**Acceptance:** a stale/lagging indexer trips the freshness guard; disagreement is detected; green.

## #24 — [deferred] feat: `@repo/capital-authority` (reservation / inventory / PnL / exposure)
**Labels:** `epic`, `deferred`, `capital` · **Effort:** large

**Context:** `@repo/capital` today is ERC-20 token helpers; the proposal's capital authority is
reservation, inventory states, realized/unrealized PnL, exposure limits, and allowance authority
(reorg Phase 7 `capital-authority`). #3's exposure cap is a risk-gate stopgap, **not** this.

**Scope:** design + build the capital-authority port + first adapter; wire reservation into the
submit path; PnL/exposure feeding risk. **Deferred** — track, scope later (likely after #2/#9).

## #25 — feat(signer): production KMS adapter  ✅ DONE (core)
**Labels:** `security`, `execution` · **Depends on:** #1 · **Effort:** ~3–5d

**Context:** #1 shipped a KMS **stub**. Proposal §5.1: real KMS needs DIGEST signing, DER decode,
recovery-id, low-s normalization, request queue/latency handling, IAM separation, key rotation.

**Scope:**
- [x] Real `@repo/signer/./aws` (`packages/signer/src/aws.ts`, named after the AWS *provider* like `@repo/secrets/./aws`): address derived from the KMS secp256k1 public key (SPKI); `Sign` with `MessageType=DIGEST`, `ECDSA_SHA_256`; DER→(r,s) via `@noble/curves`; low-s normalization (EIP-2); recovery-id brute-forced against the derived address. Plugs into the same `Signer` port (viem custom `Account`), so services are unchanged (D5).
- [x] `createAwsSigner({ keyId, address?, region?, client? })` — async (derives address at boot). `address` is **optional** (a guardrail: boot fails if it mismatches the derived one) — the key id alone is enough. Boot also validates the key's `KeySpec`/`KeyUsage`/`SigningAlgorithms` (rejects wrong-curve / encrypt-only keys early). Signatures set both `yParity` and `v`, so legacy + typed txs both serialize.
- [x] **Config-driven selection:** `createSecrets(config)` + `createSigner(resolvedConfig)` selectors; services pick `SIGNER_SOURCE=local|aws` and `SECRETS_PROVIDER=env|aws` via env (defaults `local`/`env` preserve current behavior; the local key ref defaults to `<SERVICE>_PRIVATE_KEY`). The composition root resolves a `local` key ref via `@repo/secrets` and passes the *value* into `createSigner` (as `ResolvedSignerConfig`), so `@repo/signer` has **no secrets dependency** and the key is never a `Config` field.
- [x] Also shipped `@repo/secrets/./aws` (`createAwsSecrets`, `GetSecretValue`) — the Phase C AWS stub, now real (SecretString + SecretBinary; errors wrapped with the ref, never the value).
- [x] Unit tests: a mock KMS client signs with the Anvil key so message / typed-data / legacy + EIP-1559-tx signatures genuinely recover to the derived address, plus the high-s path, wrong-curve / encrypt-only key guards, address-mismatch, and no-key cases. AWS secrets: mocked SecretString/SecretBinary/error cases.
- [x] Opt-in **integration tests** against real AWS (`aws.integration.test.ts` in both packages), gated via `describe.runIf`: set `KMS_E2E_KEY_ID` (+`AWS_REGION`) or `SECRETS_E2E_SECRET_ID` (+optional `SECRETS_E2E_EXPECTED`) and creds to run them live; skipped by default so `pnpm test` stays offline.
- [ ] **Deferred (ops, not code):** latency/queue tuning under load, IAM separation, key-rotation runbook — do when a production key is provisioned. Wiring services to *select* local-vs-KMS (a config switch at the composition root) also lands when that env exists.

**Acceptance:** ✅ KMS-produced signatures recover to the key's address across message/typed-data/tx; low-s enforced; typecheck + biome + tests green.

## #26 — [deferred] feat(domain): bad-debt liquidation policy (operator flag)
**Labels:** `deferred`, `domain`, `risk` · **Depends on:** #9 (MANUAL), #4/#24 (limits) · **Effort:** ~2–3d

**Context:** Proposal §5.2 — bad-debt liquidations are an explicit, **off-by-default**, usually
MANUAL-routed policy. Not covered anywhere.

**Scope:** a domain bad-debt policy (opt-in flag), routed MANUAL by default, bounded by capital/risk limits.

## #27 — feat: a source for **liquidation** expected profit (carried from #5)
**Labels:** `enhancement`, `risk`, `engine` · **Depends on:** one of the options below · **Effort:** ~2–4d (option-dependent)

**Context:** #5 wired the risk gate's profit floor for the **arbitrage** engine (exact, from
`previewEscrowedVaults`), but **liquidation profit is not derivable off-chain today**, so the
engine passes no `expectedProfit` and `minProfit` cannot bite on liquidations. Concretely:

- `AaveAdapterLens.estimateLiquidation` → `[amounts (per-reserve debt, in **debt-token** units),
  wbtcPayment, vaults (**bytes32 ids**, no amounts)]`.
- `AaveAdapter.liquidate` / `liquidateWithLLP` → return **only `vaultIds`**, so the
  `simulateContract` the engine already runs yields no profit either.

Pricing it needs the seized vaults' BTC value **and** the multi-token debt valued in WBTC.

**Options (pick one):**
- [ ] **A — new Lens view** (`estimateLiquidationProfit` / add a WBTC-out field): cheapest for the
  bot, needs a contracts change; natural fit alongside RFC-001 #13/#14.
- [ ] **B — on-chain WBTC-delta `ProfitGuard`** (RFC-001 §3.6, already specified for
  `LiquidatorRouter`): the guard reverts an unprofitable batch on-chain, which arguably makes the
  off-chain floor redundant for the router path. Lands with #14/#16.
- [ ] **C — off-chain price source**: price debt tokens + vault BTC in WBTC. Largest scope (feed,
  decimals, price staleness); overlaps the deferred `capital-authority` (#24).

**Acceptance:** liquidation `risk.openSlot()` receives a real `expectedProfit` in WBTC sats; the
`minProfit` floor blocks a below-floor liquidation in an engine test (the placeholder test in
`liquidation/engine.test.ts` — "does NOT apply the profit floor" — is replaced).

## Early decision spikes (do before broad parallel work)
Short issues that de-risk the parallel lanes by pinning contested interfaces first:
- **D7 — execution submission policy:** public / private-relay / fallback / profit-capped fees (unblocks #21, #9, #22).
- **D8 — indexer source contract:** Ponder response shape, `dataTimestampMs`/head-lag, direct-events (unblocks #5, #23).
- **D9 — contract accounting core:** the `maxRepayAmount` clamp mechanism, multi-reserve scalar-vs-array, gas basis for `minWbtcProfit`, access-control base, event schema (unblocks #14/#15/#17 — fold into a strengthened #13).

---

# Coupled / later

## #12 — feat(engine): drop off-chain `bufferAmounts` once `maxRepayAmount` is live
**Labels:** `enhancement`, `engine` · **Effort:** ~0.5d · **Depends on:** #14 deployed

`maxRepayAmount` resolves the debt on-chain (`order-slippage` addendum), superseding the
liquidation engine's `bufferAmounts` (+1% pad).

**Scope:** remove `bufferAmounts`; pass `maxRepayAmount` (estimate + margin) and let the
contract clamp; update the engine tests asserting on buffered amounts.

## #20 — feat: `operator-cli` (canonical MANUAL intent review/sign/submit)
**Labels:** `enhancement`, `service` · **Depends on:** #9 (done) · **Design:** `docs/design-020-operator-cli-v1.md`

`services/operator-cli` reads the canonical hashed intent from `StateStore`, re-verifies the hash,
and drives it to the chain for the operator to sign + broadcast (reorg plan Phase 8, decision
D2-resolved-to-build). Split into a **v1 (EOA + Safe, existing contracts)** that makes MANUAL
operational + e2e-testable, and the full render/batch surface deferred behind #17.

### #20a — operator-cli v1 (EOA + Safe) ✅ DONE (unit-tested, codex-reviewed, EOA + Safe e2e green)
**Effort:** ~9–12d · **Depends on:** #9 · Not blocked by #17. Full spec: `docs/design-020-operator-cli-v1.md`.

The reason it exists: without an operator half, MANUAL proposals are persisted + notified but
nobody can sign them — MANUAL is not operational. v1 delivers MANUAL's actual security value (a
human signing on real custody, no hot key in an automated process), for **both** an EOA operator
(local key for dev/e2e; hardware wallet via `confirm` in production) **and a Safe** multisig
(the production custody target). Custody is **operator-declared config** (`MANUAL_EXECUTOR_KIND=eoa|safe`,
required in MANUAL), because it changes both how a tx is broadcast and how it is confirmed.

- [x] **Config:** `MANUAL_EXECUTOR_KIND` required in MANUAL → `ExecutionSettings.executorKind`;
      `MANUAL_INTENT_STUCK_MS`; boot probes the address (`getThreshold()`/`nonce()` for `safe`,
      zero-code for `eoa`) and refuses a mismatch.
- [x] **Persistence:** a dedicated **`claimed`** status (not a reuse of `pending` — a claim has no tx,
      so it must stay out of `IN_FLIGHT_ON_CHAIN`); `proposals(action?)`, `getIntent(id)`;
      `claimProposal(id, hash, envelope?)` CAS `proposed → claimed` (the fence); `markBroadcast`
      retargets to `claimed → submitted`; `fail`/`release` recovery; one `safe_envelope` jsonb column.
- [x] **Reconcile (engine):** Safe intents (routed per-intent by `safeEnvelope`) resolve by
      `ExecutionSuccess`/`ExecutionFailure` with the full ladder (no-receipt / status=0 / Success /
      Failure / no-event→fail+warn) + event address/hash validation. **AUTO/EOA path unchanged** (regression-tested).
- [x] **Safe primitives:** `@repo/execution` pure funcs (envelope/hash/encode/decode) with an
      independent EIP-712 cross-check; `@repo/abis` `safeAbi`.
- [x] **CLI:** `list` / `show` (verify inner hash; Safe: preview hash) / `claim` / `broadcast`
      (claim → sign → `markBroadcast`) / `confirm` (external report-back, verify tx == payload/envelope)
      / `release` / `fail`, behind a hand-rolled `OperatorSigner` seam (EOA + Safe).
- [x] **Stuck recovery:** aged `claimed`/`submitted` emits `intent-stuck` once per intent (activates the
      event kept unemitted since #9c); `release` is nonce-guarded.
- [x] **MANUAL e2e — the keyless confirm flow** (production path: operator-cli `claim` → an external
      tool signs+broadcasts → `confirm --tx` re-verifies). EOA (`manual-liquidator`) green + reliable;
      Safe (`manual-safe-liquidator`) proves the `execTransaction` signing + `confirm` + `ExecutionSuccess`
      reconcile via the approvals, and a full Safe run confirmed all three intents. The intermittent
      "liquidation never proposed" was root-caused to a **test-isolation artifact**: a leftover keyed AUTO
      bot (early local run, before the cleanup-pattern fix) auto-liquidated the position on each fresh
      anvil (deterministic CREATE2 addresses), deleting it from the indexer — so the slow Safe flow lost
      the race. Not a Safe/confirm defect; CI (fresh env) is unaffected. Surfaced + fixed a Postgres
      schema-init race and an action-scoped-reconcile bug (approvals left unconfirmed).

Deferred within #20a: `show --simulate`, broadcast-time threshold re-fetch, a hardware-wallet signer
adapter, and Safe Transaction Service (`api-kit`) integration.

**Acceptance:** a MANUAL bot with **no key** proposes; `operator-cli` claims → signs (local EOA or
Safe owner keys in e2e) → broadcasts → the bot reconciles to `confirmed` (Safe via `ExecutionSuccess`);
the Safe inner-failure path lands `failed` + revives the subject; AUTO tests unchanged; green.
Implementation is unit-tested (491 tests); the e2e is the last item.

### #20b — full render/batch surface (deferred) · **Depends on:** #20a, #17
MultiSend batching + relayer-canonical (`LiquidationRelayer`) rendering, Safe Transaction Service
polling UX, hardware-wallet CI. Blocked on the contracts track (#17).

---

## Suggested lanes (if ~6 devs)

**Spikes first (day 0–2, whoever's free):** D7 (submission policy), D8 (indexer contract),
D9 (contract accounting core → folds into #13). These pin the interfaces the parallel lanes
fight over; running them first is the single biggest de-risk.

- **Lane A (execution/security):** #1 → #21 (private-relay) → #9 → #22 (RELAYER mode).
- **Lane B (reliability):** #2 (owns the persisted nonce authority; #6 only as a temp bridge) → #9 (shared with A).
- **Lane C (risk/liveness):** #3 + #4 + #5 + #23 (indexer liveness).
- **Lane D (contracts-1):** #8 → #13 (spike+core) → #14 → #16.
- **Lane E (contracts-2):** #15 (after #13) → #19; then #17 → #22 (with Lane A).
- **Lane F (test/docs/glue):** #7, #10, #18, #12, #20a (ready now); #20b after #17.

**Deferred (tracked, not scheduled yet):** #24 capital-authority, #25 KMS real adapter,
#26 bad-debt flag — epics to scope after the core lands.
