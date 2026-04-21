# Ponder Indexer

Indexes Aave V4 Spoke events and exposes API endpoints for querying positions.

## Events Tracked

### Spoke Contract
- `Supply` - Creates/updates position with supplied shares
- `Withdraw` - Decrements position shares
- `LiquidationCall` - Removes liquidated position

### Controller Contract
- `UserProxyCreated` - Maps borrower EOA to proxy address for liquidation calls

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL=http://localhost:8545

# Spoke contract address
SPOKE_ADDRESS=0x...

# AaveAdapter address
CONTROLLER_ADDRESS=0x...

# Chain ID
CHAIN_ID=1

# Block to start indexing from
START_BLOCK=0

# Polling interval in ms (default: 1000)
PONDER_POLLING_INTERVAL=1000

# PostgreSQL connection
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder

# Database schema (required for Ponder v0.13+ with PostgreSQL)
DATABASE_SCHEMA=public
```

## API Endpoints

### `GET /liquidatable-positions`

Returns positions for which `AaveAdapterLens.estimateLiquidation()` succeeds (i.e. the Lens does not revert as healthy). Each entry includes the pre-computed `amounts` and `vaults` needed to call `liquidate`/`liquidateWithLLP`.

```json
{
  "liquidatable": [
    {
      "proxyAddress": "0x...",
      "borrower": "0x...",
      "amounts": ["500000000"],
      "vaults": ["0x..."],
      "suppliedShares": "1000000000000000000"
    }
  ],
  "total": 1,
  "checked": 5
}
```

### `GET /positions`

Returns all tracked positions (debugging).

### `GET /graphql`

GraphQL endpoint for custom queries.

## Running

```bash
# From root
pnpm indexer

# Or directly
pnpm dev
```
