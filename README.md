# Aave V4 Bots Monorepo

A monorepo containing bots for Babylon's Aave V4 integration:

- **Liquidator** - Monitors positions and liquidates unhealthy ones
- **Arbitrageur** - Monitors escrowed vaults and acquires them using WBTC

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MONOREPO STRUCTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  packages/                                                                  │
│  └── shared/           Shared utilities (health, metrics server, retry)    │
│                                                                             │
│  services/                                                                  │
│  ├── liquidator/                                                            │
│  │   ├── client/       Liquidation bot (polls indexer, executes txs)       │
│  │   └── ponder/       Indexer (tracks Supply/Withdraw/Liquidation/Proxy)  │
│  │                                                                          │
│  └── arbitrageur/                                                           │
│      ├── client/       Arbitrageur bot (polls indexer, acquires vaults)    │
│      └── ponder/       Indexer (tracks VaultSwap events)                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

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
pnpm typecheck              # All packages
pnpm typecheck:shared       # Shared package only
pnpm typecheck:liquidator   # Liquidator client only
pnpm typecheck:arbitrageur  # Arbitrageur client only
```

### Testing

```bash
pnpm test                   # All packages
pnpm test:liquidator        # Liquidator tests
pnpm test:arbitrageur       # Arbitrageur tests
pnpm test:coverage          # With coverage
```

## Project Structure

```
├── packages/
│   └── shared/                 # @repo/shared - Shared utilities
│       └── src/
│           ├── health.ts       # Health check utilities
│           ├── server.ts       # Metrics/health HTTP server
│           ├── retry.ts        # Retry with exponential backoff
│           └── index.ts        # Package exports
│
├── services/
│   ├── liquidator/
│   │   └── client/             # @services/liquidator-client
│   │       └── src/
│   │           ├── bot.ts      # LiquidationBot class
│   │           ├── config.ts   # Configuration
│   │           └── metrics.ts  # Prometheus metrics
│   │
│   ├── arbitrageur/
│   │   └── client/             # @services/arbitrageur-client
│   │       └── src/
│   │           ├── bot.ts      # ArbitrageurBot class
│   │           ├── config.ts   # Configuration (with Zod)
│   │           └── metrics.ts  # Prometheus metrics
│   │
│   └── ponder/                 # @services/ponder — unified indexer (both modes)
│       ├── ponder.config.ts    #   conditional contracts by mode
│       ├── ponder.schema.ts    #   union schema
│       └── src/                #   flags.ts + guarded handlers + merged api
│
├── docker/
│   ├── liquidator-client.Dockerfile
│   ├── arbitrageur-client.Dockerfile
│   └── ponder.Dockerfile       # unified indexer image (both modes)
│
├── .github/workflows/
│   ├── ci.yml                  # Lint, typecheck, test
│   └── publish.yml             # Docker image publishing
│
├── docker-compose.yml          # All services orchestration
├── package.json                # Root workspace scripts
├── pnpm-workspace.yaml         # Workspace configuration
├── biome.json                  # Linting/formatting config
└── tsconfig.json               # Root TypeScript config
```

## Requirements

- Node.js >= 18.14
- pnpm 9.13.2+
- Docker (for containerized deployment)

## Service Documentation

- Liquidator: [overview](./docs/liquidator-overview.md), [operation guide](./docs/liquidator-operation-guide.md), [metrics](./docs/liquidator-metrics.md)
- Arbitrageur: [overview](./docs/arbitrageur-overview.md), [operation guide](./docs/arbitrageur-operation-guide.md), [metrics](./docs/arbitrageur-metrics.md)
