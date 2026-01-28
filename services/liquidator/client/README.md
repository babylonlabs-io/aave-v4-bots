# Liquidation Client

Polls the Ponder indexer for unhealthy positions and executes liquidations.

## How It Works

1. **Poll** - Fetches `/liquidatable-positions` from Ponder every N seconds
2. **Simulate** - Simulates all liquidations in parallel to filter valid ones
3. **Approve** - Ensures debt token approval for Controller (one-time)
4. **Liquidate** - Calls `AaveIntegrationController.liquidateCorePosition(proxyAddress)`
5. **Swap** (optional) - Auto-swaps seized vaults for WBTC if `AUTO_SWAP=true`

## Liquidation Flow

```
Bot                          Controller                    Aave V4
 │                               │                            │
 │ liquidateCorePosition() ─────▶│                            │
 │                               │ repay debt (from caller) ──▶│
 │                               │ transfer vaults to caller ─▶│
 │◀───────────── success ────────│                            │
 │                               │                            │
 │ swapVaultForWbtc() ──────────▶│ VaultSwap                  │
 │◀──────── WBTC received ──────│                            │
```

The liquidator:
- Repays the position's debt (needs debt tokens, e.g., USDC)
- Receives the BTC vaults as reward
- Optionally swaps seized vaults for WBTC via VaultSwap contract

## Environment Variables

```bash
# Private key of liquidator (needs debt tokens)
LIQUIDATOR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42069

# RPC URL
RPC_URL=http://localhost:8545

# AaveIntegrationController address
CONTROLLER_ADDRESS=0x...

# VaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Debt token addresses, comma-separated (optional, auto-discovered from Spoke)
DEBT_TOKEN_ADDRESSES=0x...,0x...

# Auto-swap seized vaults for WBTC (default: true)
AUTO_SWAP=true

# Poll interval (default: 10s)
POLLING_INTERVAL_MS=10000

# Metrics port (default: 9090)
METRICS_PORT=9090
```

## CLI Commands

```bash
# Start polling mode (default)
pnpm liquidate

# List vaults owned by the liquidator
pnpm liquidate:list-owned

# Swap a specific seized vault for WBTC
pnpm liquidate:swap -- <vaultId>
```

## Monitoring

The client exposes metrics and health endpoints on `METRICS_PORT` (default 9090):

- `GET /health` - Health check with ponder/RPC reachability
- `GET /metrics` - Prometheus metrics
- `GET /ready` - Readiness probe

## Testing

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage
```

## Running

```bash
# From root
pnpm liquidate

# Or directly
tsx src/index.ts
```
