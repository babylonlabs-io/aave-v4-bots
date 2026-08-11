# Aave V4 Bots Monorepo

A monorepo of keeper bots for Babylon's Aave V4 integration:

- **Liquidator** — monitors positions and liquidates unhealthy ones. Repayment is funded
  either from the bot's own token balances or, with `LIQUIDATION_FUNDING=flash`, by
  borrowing each debt token through `LiquidationRouter` and repaying it out of the seized
  collateral in the same transaction — which needs no trading inventory, only gas. See
  [Funding modes](./docs/liquidator-overview.md#funding-modes).
- **Arbitrageur** — a single bot running **both engines** off one signer: it always
  acquires escrowed vaults from the VaultSwap (arbitrage), and — when configured with
  `ADAPTER_ADDRESS` + `LENS_ADDRESS` — also runs the same `LiquidationEngine` the
  standalone liquidator uses. (That bot-side opt-in is distinct from the indexer's mode
  gating below.)
- **operator-cli** — the human side of **MANUAL** mode: review, sign, and broadcast the
  transaction proposals a keyless bot persisted (see [Execution modes](#execution-modes)).

Both bots run in one of two **execution modes**, and everything below — the signer, the
crash-safety store, the risk gate — is opt-in and off by default, so a minimal deployment
behaves exactly like a simple keeper.

## Architecture

The repo is a **package-per-concern monorepo**. Each `@repo/*` package owns exactly one
concern; the **services are thin composition roots** that wire those packages together,
own their env/metrics, and run a poll loop. The pipeline logic lives in `@repo/engine`,
whose *decision* logic is kept in pure, no-IO modules unit-tested in isolation. IO
concerns (signing, secrets, nonces, approvals, RPC) are each
isolated behind their own package + seam, so e.g. swapping a local key for AWS KMS is a
config change with no engine edit.

```
services/  ── thin composition roots: wire packages, own env + metrics, run the poll loop
  ├── arbitrageur   one bot, BOTH engines (arbitrage always; liquidation opt-in), one signer
  ├── liquidator    standalone liquidation bot (LiquidationEngine only)
  ├── operator-cli  the human side of MANUAL mode: list / show / claim / broadcast / confirm proposals
  └── ponder        unified indexer — index mode gated by which contract addresses are set
        │                (SPOKE + ADAPTER ⇒ liquidation; VAULT_SWAP ⇒ arbitrage; set either/both)
        ▼
packages/  ── @repo/*, one concern each
  ── pipelines ────────────────────────────────────────────────────────────────────────
  engine          the pipelines: LiquidationEngine + ArbitrageEngine, the Executor seam, and the
                  pure decision math (amount buffering, slippage caps, priority ordering, reserve checks)
  ── chain IO ─────────────────────────────────────────────────────────────────────────
  abis            hand-maintained contract ABIs (spoke, adapter, lens, vaultSwap, safe, erc20)
  chain           retry-with-backoff, the instrumented HTTP transport that owns RPC retry, chain reads, and ERC-20
                  balances / allowances / approvals + cached token metadata
  execution       nonce authority (shared allocator + lease), receipt waiting, tx signing
  ── identity & durability ────────────────────────────────────────────────────────────
  signer          a viem Account backed by a local key OR AWS KMS (drop-in either way)
  secrets         resolve a secret ref (an env var, or AWS Secrets Manager)
  persistence     the crash-safety StateStore — intent idempotency (Postgres / in-memory adapters)
  runtime         the shared boot: builds the ONE Executor (AUTO/MANUAL) + risk gate a service runs on
  ── safety & alerts ──────────────────────────────────────────────────────────────────
  risk            pre-execution risk gate: breaker, profit floor, code-hash guard, remote kill switch
  notifications   outbound-alert seam (Slack) for risk halts + MANUAL proposals awaiting a signature
  ── cross-cutting ────────────────────────────────────────────────────────────────────
  config          shared validated env-var schemas (zod) + fail-fast parser
  logger          structured, tagged logger
  observability   Prometheus registry + per-engine metric sets, and the HTTP server that
                  exposes them alongside /health and /ready
```

**Composition happens at the edges.** A *service* is the composition root. It hands its
`config` to `@repo/runtime`'s `startRuntime`, which builds the process's **one** `Executor`
and **one** risk gate; the service then constructs the engine(s) around them and runs the
poll loop. `@repo/engine` holds that `Executor`, **never a raw signer** — so the same
pipeline runs whether the process is keyed (AUTO) or keyless (MANUAL) — and it depends on
the chain-IO packages and the durability/safety packages (`persistence`, `risk`,
`notifications`), but **not** on `signer`/`secrets`: the runtime resolves those and hands the
engine a finished `Executor`. The engine's decision math is pure (no IO), which keeps it fast
to test.

**Everything risky is opt-in.** A local key + public-mempool sends, no persisted state, no
risk guards is the default; AWS KMS, a Postgres crash-safety store, the code-hash guard, and
the remote kill switch each switch on only when their env is set — so a minimal deployment
behaves exactly as it did before these seams existed.

The protocol's smart contracts live in the `lib/tbv-contracts/` git submodule (Babylon's
`vault-contracts-aave-v4`), but the bots don't build it or read from it at runtime: deployment
addresses come from each service's env config, and ABIs are hand-maintained in `@repo/abis`. The
submodule is the contract *source* — used to compile and deploy the protocol during the e2e suite.

The bots' *own* on-chain code is separate and does live in this repo, under `contracts/`:
`LiquidationRouter` plus its swap venues, which back flash-funded liquidations.

## Execution modes

Each bot runs in one of two modes, set by `EXECUTION_MODE` (default `AUTO`):

- **AUTO** — the bot holds the signing key and **signs + broadcasts** transactions itself.
  This is the classic keeper. The key is a local private key or an AWS KMS key (see
  [Signer & secrets](#signer--secrets)).
- **MANUAL** — the bot is **keyless**. Instead of sending, it persists a content-hashed
  **proposal** to the crash-safety store and notifies an operator. A human then uses
  **`operator-cli`** to `list` / `show` / `claim` / `broadcast` (or `confirm` an
  externally-signed tx). Custody is `eoa` (a plain account / hardware wallet) or `safe` (a
  Safe{Wallet} multisig), set by `MANUAL_EXECUTOR_KIND`. Nothing hot-signs in the bot process.

Both modes route every send through one `Executor` and one shared **nonce authority**, and
record each action as an **intent** in the store so a crash or ambiguous send can't
double-execute — on the next cycle the bot reconciles in-flight intents against the chain
before re-driving. The store (`DATABASE_URL`) is optional in AUTO and **required** in MANUAL
(the proposals must survive a restart).

## Signer & secrets

Two orthogonal seams, both defaulting to local/dev:

- **`SIGNER_SOURCE`** = `local` (a key read from an env ref, default) or `aws` (an AWS KMS
  key — the key never leaves KMS). AUTO only; MANUAL holds no key.
- **`SECRETS_PROVIDER`** = `env` (a ref is an env-var name, default) or `aws` (a ref is an
  AWS Secrets Manager id). Resolves the signer key ref, the kill-switch token, the Slack
  webhook — so no plaintext secret is hard-wired into a service.

## Risk gate & kill switch

One `RiskGate` per process, injected into every engine it runs, gates each action before it
executes. Always on: an **inventory guard** that reserves each action's worst-case token
outflow against the signer's balance until the action settles — so two engines sharing one
signer cannot each judge the same balance sufficient and together overdraw it. The rest are
`RISK_*` and opt-in: a consecutive-failure **circuit breaker**, a **profit
floor**, an **in-flight cap**, a **data-staleness** guard, and a **code-hash guard** that
pins the deployed bytecode of the contracts the bot calls (a mismatch boots it HALTED,
fail-closed). A **remote kill switch** (`RISK_CONTROL_TOKEN_REF`) serves authenticated
`POST /halt` · `POST /resume` · `GET /status` on **its own loopback socket** — deliberately
separate from the metrics port, so `/metrics` stays scrapeable while the trading-stop button
is not exposed to the scrape network.

## Quick Start

### 1. Setup Environment

Each service has its own environment configuration:

```bash
# Copy environment templates for clients (loaded from root)
cp env.liquidator.example .env.liquidator
cp env.arbitrageur.example .env.arbitrageur

# Edit each with your values
```

**Ponder Indexer** — a single unified indexer (`services/ponder`) serves both
services. The index mode is derived from which addresses are set: `ADAPTER_ADDRESS`
+ `SPOKE_ADDRESS` enable liquidation, `VAULT_SWAP_ADDRESS` enables arbitrage; set
one, the other, or both. The root scripts only set `PONDER_PORT`; the indexer reads
its env from `services/ponder/.env.local` (Ponder auto-loads it) or from the
environment you export:

```bash
pnpm liquidator:indexer    # @services/ponder on :42069 (liquidation mode if SPOKE+ADAPTER set)
pnpm arbitrageur:indexer   # @services/ponder on :42070 (arbitrage mode if VAULT_SWAP set)
pnpm indexer               # @services/ponder on :42069 (both modes when all addresses set)
```

So either `cp .env.liquidator services/ponder/.env.local` for a liquidation
instance, or export the vars before running. (The e2e harness sources the root
`.env.*` itself before invoking these scripts.)

| Component          | Env File Location            | Loaded From      |
| ------------------ | ---------------------------- | ---------------- |
| Liquidator Client  | `.env.liquidator`            | Root directory   |
| Arbitrageur Client | `.env.arbitrageur`           | Root directory   |
| Ponder (direct)    | `services/ponder/.env.local` | Ponder directory |

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Start Database(s)

```bash
# Start both databases
pnpm db:up

# Or start individually
pnpm liquidator:db:up
pnpm arbitrageur:db:up
```

### 4. Start Indexer(s)

```bash
# Liquidator indexer (port 42069)
pnpm liquidator:indexer

# Arbitrageur indexer (port 42070)
pnpm arbitrageur:indexer
```

### 5. Run Bots

```bash
# Liquidator bot
pnpm liquidator:run

# Arbitrageur bot
pnpm arbitrageur:run
```

## Docker Deployment

### Start All Services

```bash
# Build and start everything
docker compose up -d

# Or start specific services
docker compose up -d liquidator-postgres liquidator-ponder liquidator-bot
docker compose up -d arbitrageur-postgres arbitrageur-ponder arbitrageur-bot
```

### Service Ports

| Service              | Port  | Description                |
| -------------------- | ----- | -------------------------- |
| liquidator-postgres  | 5432  | Liquidator PostgreSQL      |
| liquidator-ponder    | 42069 | Liquidator Indexer API     |
| liquidator-bot    | 9090  | Liquidator Metrics/Health  |
| arbitrageur-postgres | 5433  | Arbitrageur PostgreSQL     |
| arbitrageur-ponder   | 42070 | Arbitrageur Indexer API    |
| arbitrageur-bot   | 9091  | Arbitrageur Metrics/Health |

### Stop Services

```bash
# Stop all
docker compose down

# Stop and remove volumes
docker compose down -v
```

## Development

### Linting & Formatting

```bash
pnpm check          # Run all checks
pnpm lint           # Lint only
pnpm format         # Format code
```

### Type Checking

```bash
pnpm typecheck              # Everything (all packages + services)
pnpm typecheck:packages     # @repo/* packages only
pnpm typecheck:liquidator   # Liquidator service only
pnpm typecheck:arbitrageur  # Arbitrageur service only
```

### Testing

```bash
pnpm test                   # All workspaces (packages + services)
pnpm test:liquidator        # Liquidator tests
pnpm test:arbitrageur       # Arbitrageur tests
pnpm test:coverage          # With coverage
```

### E2E suites

Each suite runs the real bot processes against a live Anvil + Bitcoin regtest, driven by the forge
scripts in `test/e2e/`. Pick one with `SUITE` (default `liquidator`):

```bash
E2E_FORK_URL=https://sepolia.gateway.tenderly.co ./scripts/e2e-local.sh  # liquidator — flash-funded, forked
SUITE=arbitrageur ./scripts/e2e-local.sh          # both engines in one process
SUITE=manual-arbitrageur ./scripts/e2e-local.sh   # MANUAL mode + operator-cli
```

The two suites split the funding modes between them, so both paths stay covered:

| Suite | Funding | Chain |
|-------|---------|-------|
| `liquidator` | `flash` — borrows every debt token, repays from the seized collateral | **fork** (`E2E_FORK_URL`) |
| `arbitrageur` and the MANUAL/stress suites | `inventory` — repays from the bot's own balances | bare anvil |

The liquidator suite needs a fork because it flash-borrows from the **real** UniswapV4 and Morpho
deployments instead of mocks — the pools are seeded, and Morpho funded, with the suite's own tokens.
It refuses to start without `E2E_FORK_URL` rather than failing later inside a pool call. The
protocol itself is still deployed fresh, so the suite keeps admin over the price feed and tokens;
its position is tuned to leave excess after the debt clears, which produces a real LLP fairness
payment and so exercises the WBTC flash-loan leg too. The fork block is pinned, so foundry serves it
from `~/.foundry/cache/rpc` after the first run and the RPC is not called again.

### Stress suite

`stress-arbitrageur` drives the dual-engine bot through a mass-liquidation cascade: two price-drop
waves make two cohorts liquidatable in turn, with nonce chaos (mempool eviction via
`anvil_dropTransaction`, then `kill -9` + restart) fired only once a real backlog exists. It asserts
nonce integrity, that every position is liquidated and every escrowed vault acquired, and that a
batch stranded behind a nonce gap recovers without halting.

```bash
SUITE=stress-arbitrageur ./scripts/e2e-local.sh                                        # 4 + 3 positions
SUITE=stress-arbitrageur STRESS_COHORT_A=24 STRESS_COHORT_B=16 ./scripts/e2e-local.sh  # mass event
SUITE=stress-arbitrageur STRESS_RACING=1 ./scripts/e2e-local.sh                        # + a rival bot
SUITE=stress-arbitrageur STRESS_PRIVATE=1 ./scripts/e2e-local.sh                       # private submission
```

| Variable | Effect |
|----------|--------|
| `STRESS_COHORT_A` / `STRESS_COHORT_B` | Positions per wave (default `4` / `3`); setup costs ~11 s each |
| `STRESS_RACING` | Runs a competing standalone liquidator; skips the nonce-chaos phases, which need a backlog the competitor would starve |
| `STRESS_ROUTER` | Acquisitions funded by a treasury through `ArbitrageRouter`; adds the front-run phases (A13/A14) |
| `STRESS_PRIVATE` | Routes the bot's sends through a stand-in Flashbots Protect (`test/e2e/scripts/fake-relay.mjs`) and has it swallow one transaction. Asserts the nonce is fenced while the relay may still land it, and released once the horizon passes (A15) |
| `E2E_STRESS_BLOCK_TIME` | Interval-mining block time in seconds (default `8`) — wide blocks are what let a backlog form |

Assertions and timings are written to `.e2e-stress-report.json`; bot logs land in `/tmp/arb-bot.log`
(and `/tmp/liq-bot.log` when racing).

## Project Structure

```
├── packages/                       # @repo/* — one concern per package
│   ├── engine/                     #   LiquidationEngine + ArbitrageEngine + Executor seam + pure decision math
│   ├── abis/                       #   hand-maintained contract ABIs (spoke/adapter/lens/vaultSwap/safe/erc20)
│   ├── chain/                      #   retry + instrumented HTTP transport + chain reads + ERC-20 balances/approvals/metadata
│   ├── execution/                  #   shared nonce authority (allocator + lease) + receipt waiting + signing
│   ├── signer/                     #   viem Account from a local key OR AWS KMS
│   ├── secrets/                    #   resolve a secret ref (env OR AWS Secrets Manager)
│   ├── persistence/                #   crash-safety StateStore — intent idempotency (Postgres / memory)
│   ├── runtime/                    #   startRuntime: builds the one Executor (AUTO/MANUAL) + risk gate
│   ├── risk/                       #   risk gate: breaker, profit floor, code-hash guard, kill switch
│   ├── notifications/              #   outbound alerts (Slack) — risk halts + MANUAL proposals
│   ├── config/                     #   shared env-var schemas (zod) + fail-fast parser
│   ├── logger/                     #   structured tagged logger
│   └── observability/              #   Prometheus registry + metric sets + the /health, /ready, /metrics server
│
├── services/
│   ├── liquidator/                 # @services/liquidator — standalone liquidation bot
│   │   └── src/                    #   index.ts (boot via startRuntime) · config.ts · bot.ts · metrics.ts
│   ├── arbitrageur/                # @services/arbitrageur — one bot, both engines
│   │   └── src/                    #   index.ts (boot + opt-in liq engine) · config.ts · bot.ts · metrics.ts
│   ├── operator-cli/               # @services/operator-cli — MANUAL-mode operator tool
│   │   └── src/                    #   index.ts (commands) · operations.ts · signer.ts (eoa/safe) · config.ts
│   └── ponder/                     # @services/ponder — unified indexer (mode-gated)
│       ├── ponder.config.ts        #   contracts included per active mode
│       ├── ponder.schema.ts        #   union schema
│       └── src/                    #   flags.ts + mode-guarded handlers + merged api
│
├── contracts/                      # the bots' own contracts — LiquidationRouter + swap venues (flash funding)
├── lib/tbv-contracts/              # git submodule — vault-contracts-aave-v4 (protocol source + deployed addrs)
├── test/e2e/                       # forge scripts driving the bots against a live Anvil + Bitcoin regtest
│                                   #   (incl. MANUAL suites: manual-arbitrageur, manual-safe-arbitrageur)
├── docker/                         # liquidator / arbitrageur / ponder Dockerfiles
├── docker-compose.yml              # all services orchestration
├── env.liquidator.example          # env templates (copy to .env.liquidator / .env.arbitrageur)
├── env.arbitrageur.example
├── package.json                    # root workspace scripts
├── pnpm-workspace.yaml             # workspace globs (packages/*, services/*)
├── biome.json                      # lint/format config
└── tsconfig.json                   # root TypeScript config
```

## Requirements

- Node.js >= 18.14
- pnpm 9.13.2+
- Docker (for containerized deployment)

## Service Documentation

- Liquidator: [overview](./docs/liquidator-overview.md), [operation guide](./docs/liquidator-operation-guide.md), [metrics](./docs/liquidator-metrics.md)
- Arbitrageur: [overview](./docs/arbitrageur-overview.md), [operation guide](./docs/arbitrageur-operation-guide.md), [metrics](./docs/arbitrageur-metrics.md)

The operation guides cover both execution modes; for the MANUAL workflow (proposals →
`operator-cli`) and the shared seams (signer/secrets, crash-safety store, risk gate & kill
switch), see the corresponding sections above and the env templates
(`env.liquidator.example`, `env.arbitrageur.example`).
