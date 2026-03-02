# Arbitrageur Client

Polls the Ponder indexer for escrowed vaults and acquires them using WBTC.

## How It Works

1. **Poll** - Fetches `/escrowed-vaults` from Ponder every N seconds
2. **Check** - Finds vaults available for acquisition with current debt
3. **Approve** - Ensures WBTC approval for VaultSwap contract (one-time)
4. **Acquire** - Calls `VaultSwap.swapWbtcForVault(vaultId, maxWbtcIn)` (redemption is atomic)

## Acquisition Flow

```
Bot                          VaultSwap                    Controller
 |                               |                            |
 | swapWbtcForVault(vaultId) -->|                            |
 |                               | pull WBTC from buyer       |
 |                               | repay debt on Hub          |
 |                               | redeemVaultFromSwap ------>|
 |                               |                            | transfer + redeem
 |<-------------- success -------|                            |
```

The arbitrageur:
- Pays WBTC to acquire the escrowed vault (debt + interest + fees)
- Vault is atomically redeemed in the same transaction

## Environment Variables

```bash
# Private key of arbitrageur (needs WBTC balance)
ARBITRAGEUR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42070

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# VaultSwap contract address (for WBTC approval)
VAULT_SWAP_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Poll interval (default: 30s)
POLLING_INTERVAL_MS=30000

# Delay between processing vaults (default: 5s)
VAULT_PROCESSING_DELAY_MS=5000

# Max slippage in basis points (default: 1%)
MAX_SLIPPAGE_BPS=100

# Metrics port (default: 9091)
METRICS_PORT=9091

# Retry configuration
RETRY_MAX_ATTEMPTS=3
RETRY_INITIAL_DELAY_MS=1000
RETRY_MAX_DELAY_MS=30000

# Transaction receipt timeout (default: 2 minutes)
TX_RECEIPT_TIMEOUT_MS=120000
```

## CLI Commands

```bash
# Start polling mode (default)
pnpm arbitrageur:run

# Show help
pnpm arbitrageur:run help
```

## Monitoring

The client exposes metrics and health endpoints on `METRICS_PORT` (default 9091):

- `GET /health` - Health check with ponder/RPC reachability
- `GET /metrics` - Prometheus metrics
- `GET /ready` - Readiness probe

## Running

```bash
# From root
pnpm arbitrageur:run

# Or directly
tsx src/index.ts
```
