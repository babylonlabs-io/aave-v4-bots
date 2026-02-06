# Arbitrageur Client

Polls the Ponder indexer for escrowed vaults and acquires them using WBTC.

## How It Works

1. **Poll** - Fetches `/escrowed-vaults` from Ponder every N seconds
2. **Check** - Finds vaults available for acquisition with current debt
3. **Approve** - Ensures WBTC approval for VaultSwap contract (one-time)
4. **Acquire** - Calls `VaultSwap.swapWbtcForVault(vaultId, maxWbtcIn)`
5. **Redeem** (optional) - Auto-redeems acquired vaults if `AUTO_REDEEM=true`

## Acquisition Flow

```
Bot                          VaultSwap                    Controller
 │                               │                            │
 │ swapWbtcForVault(vaultId) ───▶│                            │
 │                               │ pull WBTC from buyer       │
 │                               │ repay debt on Hub          │
 │                               │ releaseVaultFromSwap ─────▶│
 │                               │                            │ transfer ownership
 │◀───────────── success ────────│                            │
```

The arbitrageur:
- Pays WBTC to acquire the escrowed vault (debt + interest)
- Receives ownership of the BTC vault
- Can redeem the vault to receive the underlying BTC

## Environment Variables

```bash
# Private key of arbitrageur (needs WBTC balance)
ARBITRAGEUR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42070

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# AaveIntegrationController address
CONTROLLER_ADDRESS=0x...

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

# Auto-redeem vaults after acquiring (default: true)
AUTO_REDEEM=true

# Metrics port (default: 9090)
METRICS_PORT=9090

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
pnpm arbitrage

# List owned vaults (acquired but not yet redeemed)
pnpm arbitrage:list-owned

# Verify on-chain ownership of a vault
pnpm arbitrage:verify <vaultId>

# Redeem a specific vault
pnpm arbitrage:redeem <vaultId>

# Show help
pnpm arbitrage:help
```

## Monitoring

The client exposes metrics and health endpoints on `METRICS_PORT` (default 9090):

- `GET /health` - Health check with ponder/RPC reachability
- `GET /metrics` - Prometheus metrics
- `GET /ready` - Readiness probe

## Running

```bash
# From root
pnpm arbitrage

# Or directly
tsx src/index.ts
```


