# AGENTS.md

This file provides guidance any agent when working with code in this repository.

## Commands

pnpm workspace (pnpm 9.13.2). `packages/*` + `services/*`.

```bash
pnpm install

pnpm check                  # biome: lint + format + import sort — THIS is the gate CI runs
pnpm check:fix              # autofix
pnpm typecheck              # tsc across all packages + services

pnpm test                   # vitest, all workspaces
pnpm --filter @repo/engine test                              # one package
pnpm --filter @repo/engine test src/arbitrage/engine.test.ts # one file
pnpm --filter @repo/engine test -- -t "substring of name"    # one test (note the `--`)
```

The `--` matters: without it pnpm swallows `-t` and the whole suite runs while appearing to have
filtered. A working filter reports the non-matching tests as *skipped*.

`pnpm lint` exists but only runs the linter — CI runs `pnpm check`, which also enforces
formatting and import order. Use `check`.

Running a bot locally needs its database and indexer first:

```bash
pnpm arbitrageur:db:up && pnpm arbitrageur:indexer   # ports 5433 / 42070
pnpm arbitrageur:run
pnpm liquidator:db:up && pnpm liquidator:indexer     # ports 5432 / 42069
pnpm liquidator:run
```

### E2E

`scripts/e2e-local.sh` boots docker (postgres, bitcoin regtest), anvil, deploys the protocol from
the `contracts/` submodule, starts the real bot processes, and tears everything down on exit. It
needs `foundry` and docker. Suites are selected with `SUITE` (default `liquidator`):

```bash
SUITE=arbitrageur ./scripts/e2e-local.sh              # one bot, both engines
SUITE=manual-arbitrageur ./scripts/e2e-local.sh       # keyless MANUAL mode + operator-cli
SUITE=stress-arbitrageur ./scripts/e2e-local.sh       # mass-liquidation + nonce chaos
KEEP_DEPS=1 ./scripts/e2e-local.sh                    # reuse running postgres/btc/anvil
```

Forge scripts here need `FOUNDRY_PROFILE=e2e` (it enables `ffi`, which the suite uses to manage
bot processes). The stress suite's knobs and assertions are documented in the README.

## Architecture

**Package-per-concern monorepo.** Each `@repo/*` package owns one concern; `services/*` are thin
composition roots that wire packages together, own their env parsing and metrics, and run a poll
loop. Pipeline logic lives in `@repo/engine`, whose decision math is pure and unit-tested in
isolation; every IO concern (signing, secrets, nonces, RPC, persistence) sits behind its own
package and seam, so swapping a local key for AWS KMS is a config change with no engine edit.

**Two bots, one shared pipeline.** `@services/liquidator` runs only `LiquidationEngine`.
`@services/arbitrageur` always runs `ArbitrageEngine` and *additionally* runs the same
`LiquidationEngine` when `ADAPTER_ADDRESS` + `LENS_ADDRESS` are set. They cooperate through
BTCVaultSwap (the LLP): a liquidator calls `liquidateWithLLP`, which escrows the seized vault and
pays the liquidator WBTC at a discount; an arbitrageur later buys that escrowed vault. So the
liquidator produces exactly what the arbitrageur consumes.

**One of each, per process — this is the source of most subtlety.** `@repo/runtime`'s
`startRuntime` builds exactly one `Executor`, one `RiskGate`, and one nonce allocator, injected
into *every* engine the process runs. In the dual-engine arbitrageur that means both engines share
a signer, a nonce sequence, a token balance, and a kill switch: a breaker trip halts both, a failed
send in one engine burns a nonce the other is queued behind, and both spend the same WBTC. When
changing either engine, consider what it does to the other.

**The Executor seam** (`packages/engine/src/executor.ts`) is how AUTO and MANUAL share one
pipeline. `commit()` either signs+broadcasts under the shared nonce lock (AUTO) or writes a
content-hashed proposal for `operator-cli` to sign (MANUAL). Engines hold an `Executor`, never a
raw signer. `commit()` deliberately does **not** settle the risk slot — the engine owns that on
every exit path.

**Engine cycle shape.** Both engines: reconcile in-flight intents against the chain → resync
nonces → publish token balances to the gate → fetch candidates → *send all* → batch-wait every
receipt with `Promise.allSettled` → classify and settle. Sending and receipt-waiting are separate
phases on purpose; awaiting each receipt inline serialises the batch.

### Risk gate outcomes

`packages/risk` is a synchronous admission control: `openSlot(action)` reserves exposure plus the
action's declared token `spend`, and returns a `RiskSlot` the caller owes exactly one `settle()`
(idempotent, with `settleUnfinished` as a `finally` backstop). The outcome taxonomy carries real
weight and is easy to get wrong — the breaker exists to stop the bot when **the chain is rejecting
us**, so anything that isn't that evidence must stay off it:

| outcome | meaning | breaker | token ledger |
|---|---|---|---|
| `ok: true` | confirmed | resets streak | spent |
| `abandoned` | nothing was broadcast (duplicate, gas-estimate revert, MANUAL proposal) | exempt | released |
| `contended` | broadcast, reverted, but a competitor already took the subject | exempt | released (a revert transfers nothing) |
| `unresolved` | broadcast, receipt never arrived — fate unknown | exempt | counted as spent |
| `ok: false` | genuine failure | **feeds breaker** | released |

`contended` and `unresolved` are breaker-exempt but deliberately do **not** reset the failure
streak. Misclassifying a real failure as one of these hides it from the breaker, which is the
dangerous direction; the reverse is merely noisy.

The gate also reserves token spend so concurrent engines can't both judge the same balance
sufficient and together overdraw the signer. It fails closed on a token it has no balance for, so
an engine declaring `spend` must publish balances via `setAvailable` each cycle.

## Conventions

- Comments explain **why**, not what. The codebase is deliberately heavy on rationale where
  behaviour is non-obvious or was chosen over a plausible alternative. Match that register; don't
  narrate the code.
- Comments describe the code as it is — never what changed, was removed, or used to be there.
- `docs/` holds design docs, RFCs, and test plans, some of which are uncommitted work in progress.
  Do not cite `docs/*.md` filenames or section numbers from code, tests, or scripts.
- `contracts/` is a git submodule (Babylon's `vault-contracts-aave-v4`), excluded from biome and
  not ours to edit. ABIs are hand-maintained in `@repo/abis`; deployment addresses come from env.
- Everything risky is opt-in and off by default (KMS, Postgres persistence, code-hash guard, kill
  switch, every `RISK_*` guard), so a minimal deployment behaves like a plain keeper. Preserve
  that: a new guard should be inert until its env var is set.
- The e2e bash suites run under `set -euo pipefail`. Two failure modes have bitten repeatedly:
  unguarded command substitutions (`grep -c` exits 1 on no match), and assertions that pass
  vacuously — a drain that reads zero both before work is indexed and after it completes proves
  nothing. Assert against counts that only move one way.
