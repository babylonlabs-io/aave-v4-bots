# Liquidation Client

Polls the Ponder indexer for unhealthy positions and executes liquidations.

## How It Works

1. **Poll** - Fetches `/liquidatable-positions` from Ponder every N seconds
2. **Estimate** - Calls `estimateLiquidation(proxyAddress)` on the Lens to compute exact inputs
3. **Simulate** - Simulates all liquidations in parallel to filter valid ones
4. **Approve** - Ensures debt token approval for Adapter (one-time)
5. **Liquidate** - Calls `AaveIntegrationAdapter.liquidateCorePosition(borrower, btcRedeemKey, inputs)`

## Liquidation Flow

```
Bot                    Lens                Controller               VaultSwap
 │                       │                      │                       │
 │ estimateLiquidation()▶│                      │                       │
 │◀── inputs[], vaults[] │                      │                       │
 │                       │                      │                       │
 │ liquidateCorePosition(borrower, redeemKey, inputs) ──▶│              │
 │                       │                      │── repay debt ────────▶│
 │                       │                      │── seize + swap ──────▶│ (if redeemKey=0)
 │◀──────────── WBTC received ─────────────────│◀── WBTC ─────────────│
```

The liquidator:
- Calls the Lens to pre-compute exact inputs (debt repayments + fairness payment + protocol fee)
- Repays the position's debt (needs debt tokens, e.g., USDC)
- Receives WBTC atomically when `btcRedeemKey = bytes32(0)` (Controller handles vault swap internally)

## Environment Variables

```bash
# Private key of liquidator (needs debt tokens)
LIQUIDATOR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42069

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# AaveIntegrationAdapter address
ADAPTER_ADDRESS=0x...

# AaveIntegrationLens address
LENS_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Debt token addresses, comma-separated (optional, auto-discovered from Spoke)
DEBT_TOKEN_ADDRESSES=0x...,0x...

# BTC redeem key for direct redemption (default: bytes32(0) for WBTC payout)
# BTC_REDEEM_KEY=0x0000000000000000000000000000000000000000000000000000000000000000

# Poll interval (default: 10s)
POLLING_INTERVAL_MS=10000

# Metrics port (default: 9090)
METRICS_PORT=9090
```

## CLI Commands

```bash
# Start polling mode (default)
pnpm liquidate
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
