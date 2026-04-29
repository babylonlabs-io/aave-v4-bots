# Ponder Indexer (Arbitrageur)

Indexes BTCVaultSwap events and exposes API endpoints for the arbitrageur
client.

## Events Tracked

### BTCVaultSwap
- `AddedVault` — adds the `vaultId` to `escrowed_vault` (with the block
  timestamp as `createdAt`). Inserts use `onConflictDoNothing`.
- `RemovedVault` — deletes the row by `vaultId`.

These are the only events indexed.

## Schema

| Table | Columns |
|---|---|
| `escrowed_vault` | `vaultId hex pk`, `createdAt bigint` |

## Environment Variables

```bash
# RPC URL for indexing
PONDER_RPC_URL=http://localhost:8545

# BTCVaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# Block to start indexing from (default: 0)
START_BLOCK=0

# Polling interval in ms (default: 1000)
PONDER_POLLING_INTERVAL=1000

# Chain ID (default: 1)
CHAIN_ID=1

# PostgreSQL connection. If unset, Ponder falls back to its default
# in-memory database — indexer state is lost on restart.
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder

# Database schema (required for Ponder v0.13+)
DATABASE_SCHEMA=public
```

## API Endpoints

### `GET /escrowed-vaults`

Returns every escrowed vault, enriched with live state from the contract.
The handler reads all DB rows, then issues a single
`BTCVaultSwap.previewEscrowedVaults(bytes32[])` call with the full list.

If that batch call fails, the handler falls back to per-vault
`previewEscrowedVaults([vaultId])` calls in parallel and reports any
that failed in `failedVaultsCount`. The endpoint returns 200 if at
least one vault enriched, 500 if all failed.

```json
{
  "vaults": [
    {
      "vaultId": "0x...",
      "btcAmount": "100000000",
      "currentDebt": "100200000",
      "isProfitable": true,
      "createdAt": "1234567890"
    }
  ],
  "total": 1,
  "failedVaultsCount": 0
}
```

Field meanings:

| API field | Source on the contract tuple |
|---|---|
| `vaultId` | `vaultId` (bytes32 hex) |
| `btcAmount` | `amountVault` (sats) |
| `currentDebt` | `amountWbtcToAcquire` (= `amountDebt + amountFee`) |
| `isProfitable` | `isProfitable` |
| `createdAt` | block timestamp from the indexer DB |

The contract tuple's `amountDebt`, `amountInterest`, and `amountFee`
fields are not exposed — only the renamed `currentDebt` (acquisition
cost) and the profitability flag are surfaced.

### `GET /escrowed-vaults-raw`

Raw indexer rows without on-chain enrichment. Used for debugging.

```json
{
  "vaults": [
    { "vaultId": "0x...", "createdAt": "1234567890" }
  ],
  "total": 1
}
```

### `GET /graphql`

Ponder GraphQL endpoint over the schema.

### `* /sql/*`

Ponder SQL client.

## Running

```bash
# from repo root
pnpm arbitrageur:indexer

# or directly
pnpm dev
```
