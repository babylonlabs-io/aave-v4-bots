# Liquidator Bot

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

## Configuration

### Environment Files

The liquidator service uses two environment files:

1. **`.env.liquidator`** (root directory) - Used by the client bot
2. **`services/liquidator/ponder/.env.local`** - Used by the Ponder indexer

```bash
# Setup
cp env.liquidator.example .env.liquidator
cp .env.liquidator services/liquidator/ponder/.env.local
# Edit both files with your values
```

### Client Variables (`.env.liquidator`)

| Variable | Description |
|----------|-------------|
| `LIQUIDATOR_PRIVATE_KEY` | Wallet private key for signing transactions |
| `RPC_URL` | Ethereum RPC endpoint |
| `PONDER_URL` | Ponder indexer API URL (default: http://localhost:42069) |
| `CONTROLLER_ADDRESS` | Aave V4 Controller contract address |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address |
| `WBTC_ADDRESS` | WBTC token contract address |
| `AUTO_SWAP` | Auto-swap seized vaults for WBTC (default: true) |
| `POLLING_INTERVAL_MS` | Polling interval in milliseconds |
| `METRICS_PORT` | Port for metrics/health server (default: 9090) |

### Ponder Variables (`services/liquidator/ponder/.env.local`)

| Variable | Description |
|----------|-------------|
| `PONDER_RPC_URL_1` | RPC URL for indexing |
| `SPOKE_ADDRESS` | Spoke contract address |
| `CONTROLLER_ADDRESS` | Controller contract address |
| `CHAIN_ID` | Chain ID (default: 1) |
| `START_BLOCK` | Block to start indexing from |
| `DATABASE_URL` | PostgreSQL connection string |

## Commands

```bash
# Start in polling mode (liquidates automatically)
pnpm liquidator:run

# List vaults owned by the liquidator
pnpm liquidator:list-owned

# Swap a seized vault for WBTC
pnpm liquidator:swap -- <vaultId>
```

## API Endpoints (Ponder)

| Endpoint | Description |
|----------|-------------|
| `GET /positions` | All indexed positions |
| `GET /liquidatable-positions` | Positions with health factor < 1.0 |
| `GET /positions-health` | Position health factors |
| `GET /owned-vaults` | Vaults owned by an address |

## Metrics

Prometheus metrics available at `http://localhost:9090/metrics`:

- `liquidator_positions_checked` - Positions checked per poll
- `liquidator_positions_liquidatable` - Liquidatable positions found
- `liquidator_liquidations_total` - Total successful liquidations
- `liquidator_liquidations_failed_total` - Failed liquidation attempts
- `liquidator_vaults_seized_total` - Vaults seized from liquidations
- `liquidator_poll_duration_seconds` - Poll cycle duration

## Health Checks

- `GET /health` - Health status (healthy/degraded/unhealthy)
- `GET /ready` - Readiness probe
- `GET /metrics` - Prometheus metrics
