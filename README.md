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
2. **Liquidation Client** - Polls the indexer API for positions with health factor < 1.0, then calls `liquidate()` on the Controller

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
pnpm liquidate
```

## Project Structure

```
├── apps/
│   ├── ponder/     # Event indexer + API
│   └── client/     # Liquidation bot
├── env.example     # Environment template
└── docker-compose.yml  # PostgreSQL for Ponder
```

## Requirements

- Node.js >= 18.14
- pnpm
- Docker (for PostgreSQL)

