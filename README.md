# Aave V4 Liquidation Bot

A POC liquidation bot for Babylon's Aave V4 integration. Monitors positions and liquidates unhealthy ones.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Ponder Indexer │────▶│  Liquidation    │────▶│  Aave V4        │
│  (tracks Supply/│     │  Client         │     │  Controller     │
│   Withdraw)     │     │  (polls API)    │     │  (liquidate)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Ponder Indexer** - Indexes `Supply`, `Withdraw`, and `LiquidationCall` events from the Spoke contract to track all positions
2. **Liquidation Client** - Polls the indexer API for positions with health factor < 1.0, then calls `liquidateCorePosition()` on the Controller

## Quick Start

### 1. Setup Environment

```bash
cp env.example .env
# Edit .env with your values
```

### 2. Start Database

```bash
pnpm db:up
```

### 3. Install Dependencies

```bash
pnpm install
```

### 4. Start Indexer

```bash
pnpm indexer
```

### 5. Run Liquidation Bot

```bash
# Start polling mode (liquidates automatically)
pnpm liquidate

# List vaults owned by the liquidator
pnpm liquidate:list-owned

# Swap a specific seized vault for WBTC
pnpm liquidate:swap -- <vaultId>
```

## Docker Deployment

Run all services in Docker containers for consistent deployment across environments.

### Start All Services

```bash
# Build and start all services (postgres, ponder, client)
docker compose up -d

# Or build without cache
docker compose build --no-cache
docker compose up -d
```

### Start Specific Services

```bash
# Start only postgres and ponder (useful for development)
docker compose up -d postgres ponder

# Start client separately when ready to liquidate
docker compose up -d client
```

### Stop Services

```bash
# Stop all services
docker compose down

# Stop and remove volumes (clean slate)
docker compose down -v
```

### Service Dependencies

```
postgres (healthcheck) → ponder (healthcheck) → client
```

- **postgres**: PostgreSQL database for Ponder indexer
- **ponder**: Indexes blockchain events, exposes API on port 42069
- **client**: Liquidation bot that polls ponder and executes liquidations

## Testing

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage
```

## Project Structure

```
├── apps/
│   ├── ponder/             # Event indexer + API
│   └── client/             # Liquidation bot
├── docker/
│   ├── client.Dockerfile   # Client container
│   ├── ponder.Dockerfile   # Ponder container
│   └── .dockerignore       # Docker build exclusions
├── docker-compose.yml      # All services orchestration
└── env.example             # Environment template
```

## Requirements

- Node.js >= 18.14
- pnpm
- Docker (for containerized deployment)
