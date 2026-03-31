# Ponder Indexer

Indexes VaultSwap events and exposes API endpoints for querying escrowed vaults.

## Events Tracked

### VaultSwap Contract
- `AddedVault` - Adds vault to escrowed list (vault enters escrow after liquidation)
- `RemovedVault` - Removes vault from escrowed list (vault acquired by arbitrageur or emergency repaid)

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL=http://localhost:8545

# VaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

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

Returns escrowed vaults with live debt data fetched from the VaultSwap contract via `previewEscrowedVaults()`.

```json
{
  "vaults": [
    {
      "vaultId": "0x...",
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

### `GET /graphql`

GraphQL endpoint for custom queries.

## Running

```bash
# From root
pnpm arbitrageur:indexer

# Or directly
pnpm dev
```
