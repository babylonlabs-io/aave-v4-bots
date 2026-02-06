# Ponder Indexer

Indexes Aave V4 Spoke events and exposes API endpoints for querying positions.

## Events Tracked

### Spoke Contract
- `Supply` - Creates/updates position with supplied shares
- `Withdraw` - Decrements position shares
- `LiquidationCall` - Removes liquidated position

### Controller Contract
- `VaultOwnershipTransferred` - Tracks vault ownership changes

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL=http://localhost:8545

# Spoke contract address
SPOKE_ADDRESS=0x...

# AaveIntegrationController address
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

Returns positions with health factor < 1.0 that have debt.

```json
{
  "liquidatable": [
    {
      "proxyAddress": "0x...",
      "healthFactor": "950000000000000000",
      "totalCollateralValue": "1000000000",
      "totalDebtValue": "500000000",
      "suppliedShares": "1000000000000000000"
    }
  ],
  "total": 1,
  "checked": 5
}
```

### `GET /positions`

Returns all tracked positions (debugging).

### `GET /positions-health`

Returns all positions with their current health factors (debugging).

### `GET /owned-vaults?owner=0x...`

Returns all vaults owned by the given address.

```json
{
  "vaults": [
    {
      "vaultId": "0x...",
      "owner": "0x...",
      "previousOwner": "0x...",
      "updatedAt": "1234567890"
    }
  ],
  "total": 1
}
```

### `GET /graphql`

GraphQL endpoint for custom queries.

## Running

```bash
# From root
pnpm indexer

# Or directly
pnpm dev
```
