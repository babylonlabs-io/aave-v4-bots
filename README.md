# Aave V4 Bots Monorepo

A monorepo of keeper bots for Babylon's Aave V4 integration:

- **Liquidator** — monitors positions and liquidates unhealthy ones.
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
and the *decisions* it makes are delegated to `@repo/domain`, which is pure (no IO) and
unit-tested in isolation. IO concerns (signing, secrets, nonces, approvals, RPC) are each
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
  engine          the pipelines: LiquidationEngine + ArbitrageEngine, and the Executor seam
  domain          pure math — amount buffering, slippage caps, priority ordering, reserve checks (no IO)
  ── chain IO ─────────────────────────────────────────────────────────────────────────
  abis            hand-maintained contract ABIs (spoke, adapter, lens, vaultSwap, safe, erc20)
  capital         allowances / approvals / balances + cached token metadata
  chain           retry-with-backoff, instrumented HTTP transport, generic chain reads
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
  metrics         Prometheus registry + per-engine metric sets
  observability   HTTP server exposing /health, /ready, /metrics
```

**Composition happens at the edges.** A *service* is the composition root. It hands its
`config` to `@repo/runtime`'s `startRuntime`, which builds the process's **one** `Executor`
and **one** risk gate; the service then constructs the engine(s) around them and runs the
poll loop. `@repo/engine` holds that `Executor`, **never a raw signer** — so the same
pipeline runs whether the process is keyed (AUTO) or keyless (MANUAL) — and it depends on
`domain` (pure), the chain-IO packages, and the durability/safety packages (`persistence`,
`risk`, `notifications`), but **not** on `signer`/`secrets`: the runtime resolves those and
hands the engine a finished `Executor`. `domain` imports nothing with IO, which keeps it
pure and fast to test.

**Everything risky is opt-in.** A local key + public-mempool sends, no persisted state, no
risk guards is the default; AWS KMS, a Postgres crash-safety store, the code-hash guard, and
the remote kill switch each switch on only when their env is set — so a minimal deployment
behaves exactly as it did before these seams existed.

Smart contracts live in the `contracts/` git submodule (Babylon's `vault-contracts-aave-v4`),
but the bots don't build it or read from it at runtime: deployment addresses come from each
service's env config, and ABIs are hand-maintained in `@repo/abis`. The submodule is the
contract *source* — used to compile and deploy the protocol during the e2e suite.

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
executes (all `RISK_*`, all opt-in): a consecutive-failure **circuit breaker**, a **profit
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
docker compose up -d liquidator-postgres liquidator-ponder liquidator-client
docker compose up -d arbitrageur-postgres arbitrageur-ponder arbitrageur-client
```

### Service Ports

| Service              | Port  | Description                |
| -------------------- | ----- | -------------------------- |
| liquidator-postgres  | 5432  | Liquidator PostgreSQL      |
| liquidator-ponder    | 42069 | Liquidator Indexer API     |
| liquidator-client    | 9090  | Liquidator Metrics/Health  |
| arbitrageur-postgres | 5433  | Arbitrageur PostgreSQL     |
| arbitrageur-ponder   | 42070 | Arbitrageur Indexer API    |
| arbitrageur-client   | 9091  | Arbitrageur Metrics/Health |

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

## Project Structure

```
├── packages/                       # @repo/* — one concern per package
│   ├── engine/                     #   LiquidationEngine + ArbitrageEngine + the Executor seam
│   ├── domain/                     #   pure math: amount buffering, slippage, ordering, reserve checks
│   ├── abis/                       #   hand-maintained contract ABIs (spoke/adapter/lens/vaultSwap/safe/erc20)
│   ├── capital/                    #   allowances / approvals / balances / token metadata
│   ├── chain/                      #   retry + instrumented HTTP transport + generic chain reads
│   ├── execution/                  #   shared nonce authority (allocator + lease) + receipt waiting + signing
│   ├── signer/                     #   viem Account from a local key OR AWS KMS
│   ├── secrets/                    #   resolve a secret ref (env OR AWS Secrets Manager)
│   ├── persistence/                #   crash-safety StateStore — intent idempotency (Postgres / memory)
│   ├── runtime/                    #   startRuntime: builds the one Executor (AUTO/MANUAL) + risk gate
│   ├── risk/                       #   risk gate: breaker, profit floor, code-hash guard, kill switch
│   ├── notifications/              #   outbound alerts (Slack) — risk halts + MANUAL proposals
│   ├── config/                     #   shared env-var schemas (zod) + fail-fast parser
│   ├── logger/                     #   structured tagged logger
│   ├── metrics/                    #   Prometheus registry + metric sets
│   └── observability/              #   /health, /ready, /metrics HTTP server
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
├── contracts/                      # git submodule — vault-contracts-aave-v4 (source + deployed addrs)
├── test/e2e/                       # forge scripts driving the bots against a live Anvil + Bitcoin regtest
│                                   #   (incl. MANUAL suites: manual-liquidator, manual-safe-liquidator)
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
