# Arbitrageur Client

Polls the Ponder indexer for escrowed vaults and acquires them by paying
WBTC to BTCVaultSwap. Vault redemption happens atomically in the same tx.

## How It Works

1. **Poll** — fetches `/escrowed-vaults` from the indexer every
   `POLLING_INTERVAL_MS`. The indexer enriches DB rows with live data via
   `BTCVaultSwap.previewEscrowedVaults` so each entry already includes the
   full WBTC cost and an `isProfitable` flag.
2. **Re-check on chain** — for every vault, the bot calls
   `previewEscrowedVaults([vaultId])` directly before swapping. The bot
   trusts the on-chain answer, not the indexer's cached one.
3. **Approve** — once if `allowance(self, BTCVaultSwap) < required`,
   approves `MAX_UINT256` so future swaps are no-op on allowance.
4. **Acquire** — calls
   `BTCVaultSwap.swapWbtcForVault(vaultId, maxWbtcIn)`. The contract
   redeems the vault to the arbitrageur in the same tx — there is no
   separate redemption step.

Vaults are processed sequentially, with `VAULT_PROCESSING_DELAY_MS`
between each acquire.

## Acquisition Flow

```
Bot                          BTCVaultSwap
 │                                │
 │ swapWbtcForVault(id, max) ────▶│
 │                                │── pull WBTC from bot
 │                                │── repay Hub draw + protocol fee
 │                                │── transfer + redeem vault to bot
 │◀────── tx receipt ─────────────│
```

## What the Bot Pays

`previewEscrowedVaults` returns a tuple including:

| Field | Meaning |
|---|---|
| `amountVault` | Original BTC in the vault (sats) |
| `amountDebt` | Current Hub debt = principal + accrued interest |
| `amountInterest` | Interest accrued above the escrow-time principal |
| `amountFee` | Protocol fee (only set when profitable) |
| `amountWbtcToAcquire` | What the arbitrageur pays = `amountDebt + amountFee` |
| `isProfitable` | `true` iff vault BTC value (oracle) > `amountDebt` |

The Ponder API renames `amountWbtcToAcquire` to `currentDebt` in its JSON
response, and that's the value the bot uses for slippage:

```
maxWbtcIn = currentDebt + currentDebt * MAX_SLIPPAGE_BPS / 10000
```

## Environment Variables

```bash
# Required ---------------------------------------------------------------

# Private key of arbitrageur (needs WBTC balance)
ARBITRAGEUR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42070

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# BTCVaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Optional ---------------------------------------------------------------

# Poll interval (default: 30000 ms)
# POLLING_INTERVAL_MS=30000

# Delay between processing vaults within a single poll (default: 5000 ms)
# VAULT_PROCESSING_DELAY_MS=5000

# Max slippage in basis points (default: 100 = 1%)
# MAX_SLIPPAGE_BPS=100

# Metrics port (default: 9091)
# METRICS_PORT=9091

# Retry config for Ponder fetches and on-chain reads
# RETRY_MAX_ATTEMPTS=3
# RETRY_INITIAL_DELAY_MS=1000
# RETRY_MAX_DELAY_MS=30000

# Receipt wait timeout (default: 120000 ms)
# TX_RECEIPT_TIMEOUT_MS=120000
```

The arbitrageur does not need an adapter address — it only interacts
with BTCVaultSwap and the WBTC token.

## CLI

```bash
pnpm arbitrageur:run             # poll mode (alias: start)
pnpm arbitrageur:run help        # usage info
```

## Monitoring

The client exposes an HTTP server on `METRICS_PORT` (default 9091):

- `GET /health`, `GET /healthz` — health JSON. 200 for healthy/degraded,
  503 for unhealthy. Body: `{ status, uptime, lastPollAt, ponderReachable,
  rpcReachable, latestBlockNumber }`.
- `GET /ready`, `GET /readyz` — 200 only when both Ponder and RPC
  reachable; 503 otherwise.
- `GET /metrics` — Prometheus exposition.

The Ponder reachability probe hits `${PONDER_URL}/escrowed-vaults`, which
runs the full on-chain enrichment. Aggressive probe intervals will drive
RPC traffic.
