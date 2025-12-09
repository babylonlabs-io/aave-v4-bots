# Liquidation Client

Polls the Ponder indexer for unhealthy positions and executes liquidations.

## How It Works

1. **Poll** - Fetches `/liquidatable-positions` from Ponder every N seconds
2. **Check** - Finds positions where `healthFactor < 1e18` (i.e., < 1.0)
3. **Approve** - Ensures debt token approval for Controller (one-time)
4. **Liquidate** - Calls `AaveIntegrationController.liquidate(proxyAddress)`

## Liquidation Flow

```
Bot                          Controller                    Aave V4
 │                               │                            │
 │ liquidate(proxyAddress) ─────▶│                            │
 │                               │ repay debt (from caller) ──▶│
 │                               │ transfer vaults to caller ─▶│
 │◀───────────── success ────────│                            │
```

The liquidator:
- Repays the position's debt (needs debt tokens, e.g., USDC)
- Receives the BTC vaults as reward

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

# Debt token (e.g., USDC)
DEBT_TOKEN_ADDRESS=0x...

# Poll interval (default: 10s)
POLLING_INTERVAL_MS=10000
```

## Running

```bash
# From root
pnpm liquidate

# Or directly
tsx src/index.ts
```

