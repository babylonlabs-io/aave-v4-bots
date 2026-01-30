# Ponder Indexer

Indexes VaultSwap events and exposes API endpoints for querying escrowed vaults.

## Events Tracked

### VaultSwap Contract
- `VaultSwappedForWbtc` - Adds vault to escrowed list (seller deposits vault)
- `WbtcSwappedForVault` - Removes from escrowed, adds to owned (buyer acquires vault)
- `VaultEmergencyRepaid` - Removes vault from escrowed list (admin clears stuck vault)

### BTCVaultsManager Contract
- `VaultClaimableBy` - Removes vault from owned list (vault redeemed)

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL_1=http://localhost:8545

# VaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# BTCVaultsManager contract address (for redemption tracking)
BTC_VAULTS_MANAGER_ADDRESS=0x...

# Block to start indexing from
START_BLOCK=0

# Polling interval in ms (default: 1000)
PONDER_POLLING_INTERVAL=1000

# Chain ID
CHAIN_ID=1

# PostgreSQL connection (port 5433 to avoid conflict with liquidation bot)
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder

# Database schema (required for Ponder v0.13+)
DATABASE_SCHEMA=public
```

## API Endpoints

### `GET /escrowed-vaults`

Returns escrowed vaults with live debt data fetched from the VaultSwap contract.

```json
{
  "vaults": [
    {
      "vaultId": "0x...",
      "seller": "0x...",
      "btcAmount": "100000000",
      "currentDebt": "100000022",
      "createdAt": "1234567890"
    }
  ],
  "total": 1
}
```

### `GET /escrowed-vaults-raw`

Returns raw indexed vault data without live debt enrichment (debugging).

### `GET /owned-vaults`

Returns vaults owned by arbitrageurs (acquired but not yet redeemed).

```json
{
  "vaults": [
    {
      "vaultId": "0x...",
      "owner": "0x...",
      "btcAmount": "100000000",
      "wbtcPaid": "100000022",
      "acquiredAt": "1234567890"
    }
  ],
  "total": 1
}
```

Query parameter: `?owner=0x...` to filter by owner address.

### `GET /graphql`

GraphQL endpoint for custom queries.

## Running

```bash
# From root
pnpm indexer

# Or directly
pnpm dev
```


