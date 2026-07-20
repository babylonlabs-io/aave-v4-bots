# Refactor-002 — Production safety & integrity core (next phase)

> Follows **refactor-001** (repo decomposition — done). That phase was
> behavior-preserving: it gave us the hexagonal skeleton and the injection seams,
> but the bots are still functionally the prototype — **always-auto execution,
> private key in plaintext `.env`, no risk gate, no crash-safety, a single
> unguarded RPC/indexer.** This phase closes those gaps.

## Goal

Turn the decomposed-but-prototype bots into **production-safe execution**, by
filling the ports the proposal's runtime pipeline defines but we haven't built:
the **risk gate** (step 6), the **signer/secrets** seam (step 8), **crash-safe
persistence** (steps 9b/10), and **MANUAL/AUTO modes** + alerts (steps 9/11).
Each is a port with a first adapter, wired only in the service composition roots
— continuing the pattern from reorg-001. The on-chain contracts (`LiquidatorRouter`,
`LiquidationRelayer`, RFC-001) stay a **parallel track**, not a dependency of this
work.

## Scope

**In:** `@repo/risk`, `@repo/signer` (+ `@repo/secrets`), `@repo/persistence`,
`@repo/notifications`; the send-path refactor that threads them; MANUAL/AUTO mode;
the arbitrageur running both engines.

**Out (deferred):** the Solidity contracts and RELAYER mode / private-relay
broadcast (Flashbots/MEV-Blocker) — both gated on RFC-001; `operator-cli` (lands
once MANUAL intents exist in `StateStore`); KMS/AWS adapters beyond a stub;
`capital-authority`, `indexer` port abstraction, GCP secrets.

## Guiding principles

- **Ports in `@repo/*`, adapters wired in service roots** — same as reorg-001.
  A package depends on the *interface*, never the SDK (no `aws-sdk`/`pg` leaking
  into `engine`).
- **Behavior-preserving first adapter.** Every new port ships with a `./local` /
  `./env` / `./memory` adapter that reproduces today's behavior, so each phase
  lands green with no functional change; the "real" adapter (KMS, Postgres, Slack)
  is a later drop-in.
- **The engine gains ports, not logic.** Risk is an injected gate; signing and
  persistence move into `@repo/execution`'s submit path, behind ports.
- **One mode flag** (`AUTO | MANUAL`) selected at the composition root, not a new
  bot class — mirrors how metrics/logger were injected.

## The send path — before → after

Today the liquidation engine fuses assemble+sign+broadcast in one call
(`walletClient.writeContract(... nonce ...)`, [engine.ts §5 send loop]).
This phase splits that into a gated, persisted, signer-backed pipeline:

```
  simulate ✓                          (unchanged)
    │
    ▼
  risk.check(action)  ──block──▶ skip + metrics + (Notifier)      ← Phase B
    │ allow
    ▼
  build TxIntent  →  store.recordIntent(pending)                  ← Phase D
    │
    ├─ AUTO   → signer.sign(intent) → submitter.send(signed)      ← Phase C
    │             → store.transition(submitted, txHash)
    │             → waitForReceipt → store.transition(confirmed)  ← Phase D
    │
    └─ MANUAL → store.recordIntent(canonical) → Notifier.notify   ← Phase E
                  (operator signs via Safe/HW, broadcasts)
  on boot: store.reconcile()  → resolve pending/submitted vs chain (no double-submit)
```

## Port interfaces (from proposal §3.3, refined for a first cut)

```ts
// @repo/risk — the step-6 gate; injected into both engines like metrics
type RiskState = "RUNNING" | "HALTED";
interface RiskGate {
  state(): RiskState;
  halt(reason: string): void;                       // kill-switch
  check(action: RiskAction): RiskDecision;          // per-candidate, before submit
  recordOutcome(o: ActionOutcome): void;            // feeds breakers
}
type RiskDecision = { allow: true } | { allow: false; reason: string };

// @repo/signer — key never leaves this package; engine only sees the port
interface Signer   { address(): Address; sign(intent: TxIntent): Promise<SignedTx>; } // local | kms | manual
interface Submitter{ send(signed: SignedTx, policy: SubmitPolicy): Promise<TxHandle>; } // public now; private-relay later

// @repo/secrets — resolve refs at boot (key lives in signer, NOT here)
interface SecretsProvider { get(ref: SecretRef): Promise<Secret>; }                     // env | aws

// @repo/persistence — crash-safety
interface StateStore {
  reserveNonce(addr: Address): Promise<number>;     // persisted lease
  recordIntent(i: TxIntent): Promise<void>;         // idempotency key per (chainId, target, action, subject)
  transition(id: string, to: IntentStatus, meta?): Promise<void>;
  reconcile(): Promise<TxIntent[]>;                 // on boot: pending/submitted → check chain
}

// @repo/notifications
interface Notifier { notify(event: AlertEvent): Promise<void>; }                        // slack
```

## Phases

### Phase A — Quick win: arbitrageur runs both engines  ✅ DONE
Composed `LiquidationEngine` alongside `ArbitrageEngine` in `@services/arbitrageur`,
**opt-in via config-gating** (mirrors the ponder mode-gate): the liquidation engine
runs only when `ADAPTER_ADDRESS` + `LENS_ADDRESS` are set — half-config throws;
unset ⇒ arbitrage-only (unchanged). Both engines share the signer/clients, the
metrics registry (`liquidator_*` created on the same registry only when enabled),
the observability server, and poll independently (a liquidation tx wait can't stall
the arb loop). **Result:** arbitrageur 15 tests (4 new gating), typecheck + biome clean.

### Phase B — `@repo/risk` (kill-switch + breakers)  ✅ DONE (core)  ← the proposal's "build now"
- New zero-dep `@repo/risk`: `RiskGate` port + `createRiskGate(config)`
  (`state`/`halt`/`resume`/`check`/`recordOutcome`), 7 tests.
- **Implemented guards:** **kill-switch** (`halt`/`HALTED`), **circuit breaker**
  (`maxConsecutiveFailures` → auto-`HALTED`, reset on success), **profit floor**
  (`minProfit` vs `action.expectedProfit`), **freshness** (`maxDataStalenessMs` vs
  `action.dataTimestampMs`).
- **Injected into both engines** as a required port (like metrics/logger): `HALTED`
  short-circuits `run()`; a per-candidate `check(...)` runs before each submit;
  `recordOutcome({ok})` on every receipt feeds the breaker. Services inject a
  **permissive** gate by default (behavior == today); the engine tests drive the
  kill-switch + an end-to-end breaker trip. Engine 39 tests (was 35).
- **Deferred (follow-up):** **exposure cap** (needs stateful in-flight tracking) and
  **code-hash** (`getCode` vs expected — needs a chain read); env-driven thresholds +
  a shared per-process gate / kill-switch trigger (Phase E). The per-candidate
  `check` is wired but only enforces once the engine feeds it `expectedProfit` /
  `dataTimestampMs` — a small engine follow-up.

### Phase C — `@repo/signer` (+ `@repo/secrets`)  ✅ DONE (core; #1, #25)
- ✅ `@repo/signer`: `Signer` modelled as a viem `Account` (`./local` =
  `privateKeyToAccount`, **behavior-preserving**; `./aws` = **real** AWS KMS
  adapter, `packages/signer/src/aws.ts` — DIGEST `Sign`, DER→(r,s), low-s (EIP-2),
  recovery-id brute-forced against the SPKI-derived address; #25). `Submitter` +
  `./public` (`sendRawTransaction`) shipped as a seam; unit tests green (21,
  incl. KMS message/typed-data/tx recovery + the selectors).
- ✅ `@repo/secrets`: `SecretsProvider` + `createEnvSecrets` (env-var ref) +
  `createAwsSecrets` (**real** `GetSecretValue`, `./aws.ts`); unit tests green (10).
- ✅ **Config-driven source selection:** `createSecrets({source})` +
  `createSigner(resolvedConfig)` selectors (`SECRETS_PROVIDER=env|aws`,
  `SIGNER_SOURCE=local|aws`). Defaults (`env`/`local`, key ref
  `<SERVICE>_PRIVATE_KEY`) preserve today's behavior; switching to AWS is env-only.
  `@repo/signer` has **no secrets dependency** — the composition root resolves a
  `local` key ref and passes the value in (`ResolvedSignerConfig`).
- ✅ Services (liquidator + arbitrageur) build the signer at boot: `local` →
  `createSigner({source:"local", privateKey: await secrets.get(keyRef)})`, `aws` →
  `createSigner(config.signer)`; then the `WalletClient` uses `signer.account`. The key
  is **gone from `@repo/config`** (only the *source selection* lives there) and never
  reaches `@repo/engine`. Arbitrageur's two engines share the one signer.
- **Deferred (D5):** the explicit `@repo/execution` `submit(intent)` =
  assemble → `signer.signTransaction` → `submitter.send` split is **not** wired
  onto the hot path — viem's `writeContract` already does assemble→sign→broadcast
  through `signer.account`, so local AUTO is unchanged and KMS is a drop-in. The
  split lands in #21 (private-relay), where a non-default `Submitter` needs it.
- **Accept:** ✅ send path behaves identically with `./local`+`./public`; engine no
  longer imports the wallet key; typecheck + biome + tests green.

### Phase D — `@repo/persistence` (crash-safety)
- `StateStore` port + `./memory` (dev/tests) and `./postgres` (prod) adapters.
- Thread `recordIntent → transition` around the submit path; add `reserveNonce`
  (replaces the in-loop `nextNonce` for persisted sequencing); `reconcile()` on
  boot resolves in-flight intents against the chain **before** re-submitting.
- **Minimal-but-real double-submit guard:** idempotency key per
  `(chainId, target, action, subject)`; refuse a second `recordIntent` for a live
  key; on restart, a `submitted` intent is reconciled (receipt lookup) not resent.
- **Accept:** kill the process mid-submit in a test harness → restart re-drives
  without a duplicate tx; nonce sequence survives restart.

### Phase E — MANUAL/AUTO modes + `@repo/notifications`
- `execution` mode `AUTO | MANUAL` from config. MANUAL persists the **canonical
  signable intent** (content-hashed) to `StateStore` + `Notifier.notify`, does
  **not** broadcast. AUTO = Phase C path.
- `Notifier` port + `./slack`. Wire risk (breaker/kill-switch/stuck-funds) and
  MANUAL (pending intent) alerts (step 11).
- **Accept:** MANUAL mode produces a persisted intent + a notification and sends
  no tx; AUTO unchanged.

### Phase F — boundaries & cleanup
Tighten the dependency-boundary rules to proposal §3.4 (e.g. biome/`import`
restrictions so `engine` can't import an adapter); confirm no SDK leaks.

## Sequencing rationale

`A` (warm-up, composition-only) → `B` (risk: highest safety-per-effort, no deps,
the proposal's explicit "now") → `C` (signer: unblocks KMS and is a prerequisite
for MANUAL) → `D` (persistence: the crash-safety payoff) → `E` (modes + notify:
needs both C and D). C-before-D is a soft call — D is the higher-impact but
larger (Postgres) piece; flip if a crash-safety incident is the priority.

## Decisions to settle

- **D1 — Kill-switch trigger:** config flag vs signed token vs control endpoint.
- **D2 — `HALTED` scope:** per-process (in-memory) first, or shared in `StateStore`
  for multi-instance from day one?
- **D3 — `StateStore` first backend:** `./postgres` immediately, or `./sqlite`/
  `./memory` first and Postgres when multi-instance lands?
- **D4 — Nonce authority:** assume single active instance per key for now, or
  design leasing for multi-instance up front?
- **D5 — Local signer:** ✅ **RESOLVED** — keep AUTO-local on viem's machinery
  (model `Signer` as an `Account`; `writeContract` keeps doing assemble→sign→
  broadcast). Abstracting KMS needs only a custom `Account`. The explicit
  `sign`→`send` split is deferred to #21, the first place a private-relay
  `Submitter` actually requires it — avoids re-implementing (and having to test)
  tx assembly with no behavior change today.

## Deferred (parallel or later)

- **Contracts (RFC-001):** `LiquidatorRouter` (batching), `LiquidationRelayer`
  (payer-relayer, flash venues) — separate Solidity + audit track.
- **RELAYER mode + private relay** (Flashbots/MEV-Blocker) — after contracts.
- **`operator-cli`** — after MANUAL intents exist in `StateStore`.
- **KMS/AWS/GCP** real adapters, `capital-authority`, `indexer` port.

## Codex (gpt-5.5) input

_Not folded in — the codex run completed but its output was lost when the session
scratchpad was cleaned before it could be captured. Re-run if its refinements are wanted;
the plan stands on the proposal without it._
