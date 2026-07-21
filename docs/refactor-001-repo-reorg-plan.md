# Refactor-001 — Repo reorg plan (gradual)

> Migrate the current prototype layout to the
> [architecture proposal](./production-architecture-proposal.md) §3.3 structure,
> **gradually**, keeping CI / typecheck / the running bots green at every step.

## Status

- ✅ **Phase 1** — `@repo/abis` + `@repo/observability` extracted, consumers flipped.
- ✅ **Phase 2** — `@repo/chain` seeded (`retry` + `instrumentedTransport`);
  **`@repo/shared` deleted**; root `typecheck:packages` + CI updated. (`chain`
  readers/lens/sim still to come during the engine decomposition, Phase 5–6.)
- 🟡 **Phase 4a** — new unified **`services/ponder`** (`@services/ponder`) built
  *additively* (old per-service ponders kept as fallback): conditional contracts +
  handlers by mode (liquidation / arbitrage, derived from configured addresses),
  union schema, merged API, single port. Validated offline (unit test 3/3, biome).
  **ABIs unified** ✅ — added the indexer *event* entries (`Spoke` Supply/Withdraw/
  LiquidationCall, `VaultSwap` AddedVault/RemovedVault) to `@repo/abis` (additive, so
  client function calls are unaffected), pointed ponder at `@repo/abis`, and deleted
  `services/ponder/abis`. Validated: client typechecks + tests green, and `ponder dev`
  boots in both-modes resolving every event from `@repo/abis`.
  - ✅ Validated with **`ponder dev`** offline (no real RPC): boots in
    liquidation-only, arbitrage-only, and both-modes; no-modes fails fast with the
    guard. This exercises the conditional config + handler registration (the part
    `ponder codegen` can't — codegen only writes the static `ponder-env.d.ts`).
  - ✅ **e2e wiring:** `liquidator:indexer` / `arbitrageur:indexer` now run
    `@services/ponder` (ports 42069 / 42070), so the existing e2e harness
    (`test/e2e/LiquidationE2ESetup.s.sol` FFI) tests the unified service **unchanged**.
    Remaining e2e validation = run it against the devnet (RPC + Postgres + indexing).
- ✅ **Phase 4b (cutover)** — deleted both per-service ponder apps + their
  Dockerfiles; one `docker/ponder.Dockerfile` (mode by env); `docker-compose` keeps
  two instances (liquidator-ponder :42069 / arbitrageur-ponder :42070) off the
  unified image; `publish.yml` both indexer jobs build it (repoNames kept,
  non-breaking); `services/*/ponder` workspace glob removed; biome/gitignore + README
  + operation guides updated. Typecheck/tests green (liq 52, arb 33, ponder 3).
  - ⏳ Still operator-run: the **e2e** against the devnet (the harness already calls
    the repointed `*:indexer` scripts, so no further changes needed).
- ✅ **Phase 3** — `@repo/config`: shared Zod field schemas (`addressSchema`,
  `privateKeySchema`, `bytes32Schema`, `urlSchema`, `positive/nonNegativeIntSchema`,
  `addressListSchema`) + a fail-fast `parseEnv`. **Liquidator migrated off hand-rolled
  validation onto Zod** (now `process.exit(1)` like the arbitrageur; its config test
  rewritten to the exit pattern); **arbitrageur deduped** onto the shared primitives +
  `parseEnv`. Resolves the proposal's "Zod vs hand-rolled" split (§8).
  - Note: liquidator URLs are now URL-validated (previously presence-only) — slightly
    stricter, intentional.

- 🟡 **Phase 5 (started)** — `@repo/domain` created with the **pure** logic extracted
  from both `bot.ts` (no IO): `bufferAmounts`, `sequentialPriorityOrder`,
  `isBorrowableReserve` + `RESERVE_FLAG` (liquidator), `maxWbtcInWithSlippage`
  (arbitrageur). Both bots import them; 9 unit tests; bot tests unchanged (behavior
  preserved).
- 🟡 **Phase 6 (started) — `@repo/capital`** — extracted the ERC-20 leaf primitives
  (`readTokenMeta`, `TokenMetaCache`, `readBalance`, `readAllowance`, `approveMax`)
  shared by both bots' inventory/approval logic. Each bot now composes them while
  keeping its own orchestration (liquidator: multi-token, Map cache, no retry;
  arbitrageur: single WBTC, `withRetry`-wrapped) — so `bot.test.ts` (which keys mocks on
  `functionName`) stays green.
- 🟡 **Phase 6 — `@repo/execution`** — extracted `nextNonce` (pending-nonce source,
  used by the liquidator's send loop) and `waitForReceipt` (null-on-timeout receipt
  wait, replacing the arbitrageur's `waitForReceiptWithTimeout` core + `createTimeout`).
  Each bot keeps its send/nonce-resync loop and receipt logging. Bot tests unchanged.
- 🟡 **Phase 6 — `@repo/engine`** — the two pipeline classes moved out of the services
  into `LiquidationEngine` and `ArbitrageEngine` (two engines because the arbitrageur
  will run both). Each takes an injected **metrics port** (`LiquidationMetrics` /
  `ArbitrageMetrics`) and the arbitrage engine an `onPollComplete` health hook, so the
  engines carry no prom-client / service coupling. Each service `bot.ts` is now a thin
  wrapper (`LiquidationBot extends LiquidationEngine`, injecting `./metrics`) — so
  `index.ts` and `bot.test.ts` are unchanged and green (the tests' `vi.mock("./metrics")`
  still flows through the wrapper's import). Engine data models (`LiquidatablePosition`,
  `EscrowedVault`) moved to the engine; `./types.ts` re-exports them.
  Remaining Phase 6: a `risk` package — deferred, there's almost no explicit risk logic
  in the current code to extract (guards/breakers are the architecture proposal's *new*
  scope, not present here).

Each landed phase kept `typecheck` / `biome` / tests green (liquidator 56, arbitrageur 33,
ponder 3, domain 9).

## Guiding principles

1. **Green at every step.** Each phase is a small, reviewable PR that leaves
   `pnpm typecheck`, `pnpm test`, CI, and both bots working.
2. **Strangler façade.** While splitting `@repo/shared`, keep it as a thin
   **re-export façade** so existing imports keep working; flip imports per-package,
   then delete the façade last.
3. **Reorg ≠ greenfield.** Separate *moving code that exists* from *scaffolding new
   packages*. Most target packages are new — create them when the feature lands,
   not up front as empty noise.
4. **Pure before IO.** Extract pure logic (`domain`) before the IO subsystems
   (`execution`/`capital`/`risk`), so the hard decomposition is testable in isolation.

## Current → target mapping

| Current | Target | Notes |
|---------|--------|-------|
| `packages/shared/src/health.ts`, `server.ts` + clients' `health.ts`/`metrics.ts`/`server.ts` | `packages/observability` | duplicated across both clients today |
| `packages/shared/src/instrumentedTransport.ts`, `retry.ts` | `packages/chain` | transport + RPC plumbing |
| `packages/shared/src/abis/*` | `packages/abis` (standalone `@repo/abis`, consumed by `chain` + `ponder`) | D1: standalone |
| clients' `config.ts` (zod) | `packages/config` | unify the two |
| clients' `bot.ts` (logic) | `domain` + `engine` + `chain` + `execution` + `capital` + `risk` | the core decomposition (phase 5–6) |
| clients' `types.ts` | split across `domain` / `engine` | |
| `services/{liquidator,arbitrageur}/client` | flattened to `services/{liquidator,arbitrageur}` (dropped redundant `client/` nesting once ponder moved out); **thin composition roots**, package `@services/{liquidator,arbitrageur}` | wire ports → adapters |
| `services/{liquidator,arbitrageur}/ponder` | `services/ponder` (single, configurable) | phase 4; both ABI sets |
| `contracts/` (empty) | `contracts/LiquidatorRouter`, `contracts/LiquidationRelayer` | greenfield, per RFC-001 |
| — (new) | `engine, execution, capital, risk, secrets, signer, notifications, indexer, persistence, capital-authority, operator-cli` | greenfield |

## Phases

### Phase 0 — Skeleton & guardrails (no logic moves)
- Create empty stubs only for packages that will receive **existing** code soon:
  `observability`, `chain`, `config`. (Defer the rest until their feature lands.)
  Each: `package.json` (`@repo/<name>`), `src/index.ts`, `tsconfig`.
- Update `pnpm-workspace.yaml` globs to also match `services/ponder` and
  `services/operator-cli` (future), so later phases don't touch workspace wiring.
- Add a CI **dependency-boundary** check stub (`dependency-cruiser`) — start
  permissive, tighten per phase. Encodes proposal §3.4 (domain imports nothing;
  adapters only in service roots).
- *Exit:* repo green, nothing imports the new stubs yet.

### Phase 1 — `observability` (lowest risk)
- Move `shared/src/{health,server}.ts` and the duplicated client
  `health.ts`/`metrics.ts`/`server.ts` into `packages/observability`,
  parameterized (no per-service copy).
- `@repo/shared` re-exports from `@repo/observability` (façade).
- Point both clients at `@repo/observability`.
- *Exit:* one health/metrics implementation; clients shrink.

### Phase 2 — `chain`
- Move `instrumentedTransport.ts`, `retry.ts`, `abis/*` into `packages/chain`.
- Add a thin `ChainReader` (rpc-pool wrapper, lens/multicall reads) extracted from
  the read calls currently inline in `bot.ts`.
- Façade `@repo/shared` → `@repo/chain`; flip client imports.
- *Exit:* all RPC/ABIs behind `chain`; `@repo/shared` now only a façade.

### Phase 3 — `config`
- Extract the zod schemas from both clients into `packages/config` as a shared base
  + per-service extension (proposal §8). Keep env-var back-compat.
- *Exit:* one validated config tree; `config.test.ts` move with it.

### Phase 4 — `ponder` consolidation (independent track)
- Merge `services/{liquidator,arbitrageur}/ponder` → `services/ponder` carrying both
  ABI sets, with config to enable liquidation and/or arbitrage indexing.
- Update workspace glob (`services/*/ponder` → `services/ponder`), `docker-compose`,
  and the `*:indexer*` package.json scripts.
- *Exit:* one indexer codebase; operators run one or two instances by config.

### Phase 5 — decompose into `domain` + `engine` (the core)
- Pull pure logic out of `bot.ts` into `packages/domain` (profitability, route
  planning, bad-debt, prioritization — no IO) with unit tests.
- Introduce `packages/engine` orchestrating the pipeline over **port interfaces**
  (chain reads, execution, capital, risk); clients keep wiring concrete deps.
- Shared `LiquidationEngine` parameterized by adapter call; `ArbitrageEngine` for the
  arbitrageur (proposal §4).
- *Exit:* `bot.ts` becomes a thin assembler; logic is unit-tested off-chain.

### Phase 6 — `execution` / `capital` / `risk`
- As the engine stabilizes, move tx assembly + submission → `execution`,
  balances/inventory/PnL/reservation → `capital`, breakers/guards/kill-switch →
  `risk`. Each behind its port; adapters wired only in service roots.

### Phase 7 — integration seams (greenfield, as features land)
- Scaffold `secrets, signer, notifications, indexer, persistence, capital-authority`
  with interface + first adapter **when** the corresponding feature is implemented
  (KMS, Slack, Postgres, …) — not as empty packages now.

### Phase 8 — `operator-cli` + `contracts`
- New `services/operator-cli` (gated by decision D2) and the Solidity contracts
  (`LiquidatorRouter`, `LiquidationRelayer`) per RFC-001. Greenfield.

### Phase 9 — cleanup
- Delete the `@repo/shared` façade once nothing imports it. Tighten the
  dependency-boundary rules to the proposal §3.4 final form.

## Decisions to settle before/while starting

- **D1 — ABIs home.** ✅ **Resolved: standalone `@repo/abis`** package, consumed by
  both `chain` and `ponder`.
- **D2 — operator-cli vs notify-only.** ✅ **Resolved: build the `operator-cli`** —
  full canonical intent review / sign / submit (HW wallet + Safe). Phase 8 includes it.
- **D3 — ponder: one instance or per-service.** Code is consolidated either way
  (Phase 4); this is a *deployment* choice operators make via config.
- **D4 — package namespace.** Keep `@repo/*` for packages, `@services/*` for service
  roots (current convention) to minimize churn.

## Mechanical checklist (touched each move)

`pnpm-workspace.yaml` globs · package names & `exports` · `tsconfig` · `biome.json`
paths · `docker-compose.yml` + `docker/` Dockerfiles · CI workflows referencing
`pnpm --filter` names · `.env*` files · root `package.json` scripts.

## Suggested first PR

Phase 0 + Phase 1 together: skeleton for `{observability, chain, config}` + the
`observability` extraction with the `@repo/shared` façade. Small, fully green,
removes the most duplication, and proves the strangler pattern before the harder
phases.
