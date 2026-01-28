# Arbitrageur Bot

A POC arbitrageur bot for Babylon's Aave V4 integration. Monitors escrowed vaults and acquires them using WBTC.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Ponder Indexer │────▶│  Arbitrageur    │────▶│  Aave V4        │
│  (tracks Vault  │     │  Client         │     │  Controller     │
│   Swap events)  │     │  (polls API)    │     │  (swap/redeem)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Ponder Indexer** - Indexes `VaultSwappedForWbtc`, `WbtcSwappedForVault`, and `VaultEmergencyRepaid` events from VaultSwap contract to track escrowed vaults
2. **Arbitrageur Client** - Polls the indexer API for escrowed vaults with live debt data, then calls `swapWbtcForVault()` on the VaultSwap contract

## Configuration

### Environment Files

The arbitrageur service uses two environment files:

1. **`.env.arbitrageur`** (root directory) - Used by the client bot
2. **`services/arbitrageur/ponder/.env.local`** - Used by the Ponder indexer

```bash
# Setup
cp env.arbitrageur.example .env.arbitrageur
cp .env.arbitrageur services/arbitrageur/ponder/.env.local
# Edit both files with your values
```

### Client Variables (`.env.arbitrageur`)

| Variable | Description |
|----------|-------------|
| `ARBITRAGEUR_PRIVATE_KEY` | Wallet private key for signing transactions |
| `RPC_URL` | Ethereum RPC endpoint |
| `PONDER_URL` | Ponder indexer API URL (default: http://localhost:42070) |
| `CONTROLLER_ADDRESS` | Aave V4 Controller contract address |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address |
| `WBTC_ADDRESS` | WBTC token contract address |
| `MAX_SLIPPAGE_BPS` | Maximum slippage in basis points (default: 100 = 1%) |
| `AUTO_REDEEM` | Auto-redeem acquired vaults (default: true) |
| `POLLING_INTERVAL_MS` | Polling interval in milliseconds |
| `METRICS_PORT` | Port for metrics/health server (default: 9091) |

### Ponder Variables (`services/arbitrageur/ponder/.env.local`)

| Variable | Description |
|----------|-------------|
| `PONDER_RPC_URL_1` | RPC URL for indexing |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address |
| `BTC_VAULTS_MANAGER_ADDRESS` | BTCVaultsManager contract address |
| `CHAIN_ID` | Chain ID (default: 1) |
| `START_BLOCK` | Block to start indexing from |
| `DATABASE_URL` | PostgreSQL connection string (use port 5433) |

## Commands

```bash
# Start in polling mode (acquires vaults automatically)
pnpm arbitrageur:run

# List owned vaults (acquired but not yet redeemed)
pnpm arbitrageur:list-owned

# Verify ownership of a specific vault
pnpm arbitrageur:verify <vaultId>

# Redeem a specific vault
pnpm arbitrageur:redeem <vaultId>
```

## API Endpoints (Ponder)

| Endpoint | Description |
|----------|-------------|
| `GET /escrowed-vaults` | All escrowed vaults available for acquisition |
| `GET /escrowed-vaults-raw` | Raw escrowed vault data |
| `GET /owned-vaults` | Vaults owned by an address |

## Metrics

Prometheus metrics available at `http://localhost:9091/metrics`:

- `arbitrageur_vaults_acquired_total` - Total vaults acquired
- `arbitrageur_wbtc_spent_total` - Total WBTC spent (in satoshis)
- `arbitrageur_wbtc_balance` - Current WBTC balance
- `arbitrageur_poll_duration_seconds` - Poll cycle duration
- `arbitrageur_errors_total` - Errors by type

## Health Checks

- `GET /health` - Health status (healthy/degraded/unhealthy)
- `GET /ready` - Readiness probe
- `GET /metrics` - Prometheus metrics
