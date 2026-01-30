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
│  │   └── ponder/       Indexer (tracks Supply/Withdraw/Liquidation)        │
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

**Ponder Indexers** require their own `.env.local` files in their respective directories:

```bash
# For liquidator ponder - copy relevant vars from .env.liquidator
cp .env.liquidator services/liquidator/ponder/.env.local

# For arbitrageur ponder - copy relevant vars from .env.arbitrageur
cp .env.arbitrageur services/arbitrageur/ponder/.env.local
```

| Component | Env File Location | Loaded From |
|-----------|------------------|-------------|
| Liquidator Client | `.env.liquidator` | Root directory |
| Liquidator Ponder | `services/liquidator/ponder/.env.local` | Ponder directory |
| Arbitrageur Client | `.env.arbitrageur` | Root directory |
| Arbitrageur Ponder | `services/arbitrageur/ponder/.env.local` | Ponder directory |

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
pnpm liquidator:list-owned
pnpm liquidator:swap -- <vaultId>

# Arbitrageur bot
pnpm arbitrageur:run
pnpm arbitrageur:list-owned
pnpm arbitrageur:verify <vaultId>
pnpm arbitrageur:redeem <vaultId>
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

| Service | Port | Description |
|---------|------|-------------|
| liquidator-postgres | 5432 | Liquidator PostgreSQL |
| liquidator-ponder | 42069 | Liquidator Indexer API |
| liquidator-client | 9090 | Liquidator Metrics/Health |
| arbitrageur-postgres | 5433 | Arbitrageur PostgreSQL |
| arbitrageur-ponder | 42070 | Arbitrageur Indexer API |
| arbitrageur-client | 9091 | Arbitrageur Metrics/Health |

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
│   │   ├── client/             # @services/liquidator-client
│   │   │   └── src/
│   │   │       ├── bot.ts      # LiquidationBot class
│   │   │       ├── config.ts   # Configuration
│   │   │       └── metrics.ts  # Prometheus metrics
│   │   └── ponder/             # @services/liquidator-ponder
│   │       ├── ponder.config.ts
│   │       ├── ponder.schema.ts
│   │       └── src/
│   │
│   └── arbitrageur/
│       ├── client/             # @services/arbitrageur-client
│       │   └── src/
│       │       ├── bot.ts      # ArbitrageurBot class
│       │       ├── config.ts   # Configuration (with Zod)
│       │       └── metrics.ts  # Prometheus metrics
│       └── ponder/             # @services/arbitrageur-ponder
│           ├── ponder.config.ts
│           ├── ponder.schema.ts
│           └── src/
│
├── docker/
│   ├── liquidator-client.Dockerfile
│   ├── liquidator-ponder.Dockerfile
│   ├── arbitrageur-client.Dockerfile
│   └── arbitrageur-ponder.Dockerfile
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

- [Liquidator Documentation](./docs/liquidator.md)
- [Arbitrageur Documentation](./docs/arbitrageur.md)
