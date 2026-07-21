# Aave V4 Bots Monorepo

A monorepo of keeper bots for Babylon's Aave V4 integration:

- **Liquidator** — monitors positions and liquidates unhealthy ones.
- **Arbitrageur** — a single bot running **both engines** off one signer: it always
  acquires escrowed vaults from the VaultSwap (arbitrage), and — when configured with
  `ADAPTER_ADDRESS` + `LENS_ADDRESS` — also runs the same `LiquidationEngine` the
  standalone liquidator uses. (That bot-side opt-in is distinct from the indexer's mode
  gating below.)

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
  └── ponder        unified indexer — index mode gated by which contract addresses are set
        │                (SPOKE + ADAPTER ⇒ liquidation; VAULT_SWAP ⇒ arbitrage; set either/both)
        ▼
packages/  ── @repo/*, one concern each
  engine          the pipelines: LiquidationEngine + ArbitrageEngine (orchestration/IO)
  domain          pure math — amount buffering, slippage caps, priority ordering, reserve checks (no IO)
  ── chain IO ─────────────────────────────────────────────────────────────────────────
  abis            hand-maintained contract ABIs (spoke, adapter, lens, vaultSwap, erc20)
  capital         allowances / approvals / balances + cached token metadata
  chain           retry-with-backoff + instrumented HTTP transport
  execution       transaction execution — nonce authority, receipt waiting
  signer          a viem Account backed by a local key OR AWS KMS (drop-in either way)
  secrets         resolve a secret ref (an env var today, AWS Secrets Manager later)
  ── cross-cutting ────────────────────────────────────────────────────────────────────
  config          shared validated env-var schemas (zod) + fail-fast parser
  risk            pre-execution risk gate checked before each action
  logger          structured, tagged logger
  metrics         Prometheus registry + per-engine metric sets
  observability   HTTP server exposing /health, /ready, /metrics
```

**Composition happens at the edges.** A *service* is the composition root: it wires the
engine together with a `signer`, `secrets`, `config`, `metrics`, and `observability`, and
injects the built wallet client into the engine. `@repo/engine` itself depends only on
`domain` (pure) plus the chain-IO packages (`abis`, `capital`, `chain`, `execution`) and
`risk`/`logger` — **not** on `signer`/`secrets`, and never on a service. `domain` imports
nothing with IO, which keeps it pure and fast to test.

Smart contracts live in the `contracts/` git submodule (Babylon's `vault-contracts-aave-v4`),
but the bots don't build it or read from it at runtime: deployment addresses come from each
service's env config, and ABIs are hand-maintained in `@repo/abis`. The submodule is the
contract *source* — used to compile and deploy the protocol during the e2e suite.

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
│   ├── engine/                     #   LiquidationEngine + ArbitrageEngine (the pipelines)
│   ├── domain/                     #   pure math: amount buffering, slippage, ordering, reserve checks
│   ├── abis/                       #   hand-maintained contract ABIs
│   ├── capital/                    #   allowances / approvals / balances / token metadata
│   ├── chain/                      #   retry + instrumented HTTP transport
│   ├── execution/                  #   nonce authority + receipt waiting
│   ├── signer/                     #   viem Account from a local key OR AWS KMS
│   ├── secrets/                    #   resolve a secret ref (env OR AWS Secrets Manager)
│   ├── config/                     #   shared env-var schemas (zod) + fail-fast parser
│   ├── risk/                       #   pre-execution risk gate
│   ├── logger/                     #   structured tagged logger
│   ├── metrics/                    #   Prometheus registry + metric sets
│   └── observability/              #   /health, /ready, /metrics HTTP server
│
├── services/
│   ├── liquidator/                 # @services/liquidator — standalone liquidation bot
│   │   └── src/                    #   index.ts (boot) · config.ts · bot.ts · metrics.ts
│   ├── arbitrageur/                # @services/arbitrageur — one bot, both engines
│   │   └── src/                    #   index.ts (boot + opt-in liq engine) · config.ts · bot.ts · metrics.ts
│   └── ponder/                     # @services/ponder — unified indexer (mode-gated)
│       ├── ponder.config.ts        #   contracts included per active mode
│       ├── ponder.schema.ts        #   union schema
│       └── src/                    #   flags.ts + mode-guarded handlers + merged api
│
├── contracts/                      # git submodule — vault-contracts-aave-v4 (source + deployed addrs)
├── test/e2e/                       # forge scripts driving the bots against a live Anvil + Bitcoin regtest
│
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
