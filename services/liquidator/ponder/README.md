# Ponder Indexer (Liquidator)

Indexes Aave v4 Spoke and AaveAdapter events and exposes API endpoints
for the liquidation client.

## Events Tracked

### Spoke
- `Supply` — creates/updates a `position` row, accumulating supplied shares.
- `Withdraw` — decrements supplied shares; deletes the row when shares ≤ 0.
- `LiquidationCall` — decrements by `collateralSharesLiquidated`; deletes
  the row when shares ≤ 0.

### AaveAdapter

- `UserProxyCreated` — populates `proxy_mapping` (proxyAddress → borrower)
  so the API can look up the EOA for each liquidatable position.

## Schema

| Table | Columns |
|---|---|
| `position` | `proxyAddress hex pk`, `suppliedShares bigint`, `createdAt bigint`, `updatedAt bigint` |
| `proxy_mapping` | `proxyAddress hex pk`, `borrower hex`, `createdAt bigint` |

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL=http://localhost:8545

# Spoke contract address
SPOKE_ADDRESS=0x...

# AaveAdapter address
ADAPTER_ADDRESS=0x...

# Chain ID (default: 1)
CHAIN_ID=1

# Block to start indexing from (default: 0)
START_BLOCK=0

# Polling interval in ms (default: 1000)
PONDER_POLLING_INTERVAL=1000

# PostgreSQL connection. If unset, Ponder falls back to an in-memory
# pglite database — indexer state is lost on restart.
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder

# Database schema (required for Ponder v0.13+)
DATABASE_SCHEMA=public

# Required at request time by /liquidatable-positions; the route returns
# 500 if it is not set when called.
LENS_ADDRESS=0x...
```

## API Endpoints

### `GET /liquidatable-positions`

For every position in the indexer's table, calls
`AaveAdapterLens.estimateLiquidation(proxyAddress, false)` on `LENS_ADDRESS`
via `eth_call`. The Lens reverts when a position is healthy; only
fulfilled results are returned.

> Note: `isDirectRedemption` is hardcoded to `false` here. Operators
> running the bot with `IS_DIRECT_REDEMPTION=true` may see candidates
> filtered out at the indexer that would have been liquidatable in
> direct mode, and vice versa. The bot re-estimates per candidate with
> its actual mode before broadcasting.

Response:

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

`amounts` and `vaults` are passed straight to
`AaveAdapter.liquidate` / `liquidateWithLLP`.

### `GET /positions`

Returns the raw position table, used for debugging and as the bot's
Ponder health probe target. Returns every row.

### `GET /graphql`

Ponder GraphQL endpoint over the schema.

### `* /sql/*`

Ponder SQL client.

## Running

```bash
# from repo root
pnpm liquidator:indexer

# or directly
pnpm dev
```
