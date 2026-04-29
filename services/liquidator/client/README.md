# Liquidation Client

Polls the Ponder indexer for unhealthy positions and executes liquidations
against the AaveAdapter contract.

## How It Works

1. **Discover debt tokens** — at boot, either reads `DEBT_TOKEN_ADDRESSES` or
   enumerates the Spoke's reserves and selects those flagged borrowable.
2. **Approve** — once at boot, sets `MAX_UINT256` allowance on every debt
   token for the AaveAdapter contract.
3. **Poll** — fetches `/liquidatable-positions` from the indexer every
   `POLLING_INTERVAL_MS`.
4. **Estimate** — for each candidate, calls
   `AaveAdapterLens.estimateLiquidation(proxy, isDirectRedemption)` to get
   `(uint256[] amounts, bytes32[] vaults)`. Each amount is bumped by 1% to
   absorb interest accrued between estimate and broadcast.
5. **Simulate** — simulates every candidate against the adapter; drops any
   that revert.
6. **Liquidate** — calls one of two adapter functions depending on
   `IS_DIRECT_REDEMPTION`:
   - `IS_DIRECT_REDEMPTION=true` →
     `AaveAdapter.liquidate(borrower, BTC_REDEEM_KEY, amounts, priorityOrder)`.
     Seized vault is redeemed directly to `BTC_REDEEM_KEY`.
   - default (`false`) →
     `AaveAdapter.liquidateWithLLP(borrower, LLP_ADDRESS, amounts, priorityOrder, [])`.
     Seized vault is escrowed in the LLP (BTCVaultSwap) for an arbitrageur to
     acquire later. The empty `requestedTokens` array means the liquidator
     does not request any LLP-side payout in this tx.

`priorityOrder` is always `[0, 1, …, n-1]`.

## Liquidation Flow

```
Bot                Lens                AaveAdapter           Spoke / LLP
 │                   │                       │                     │
 │ estimateLiquidation()                                            │
 │ ──────────────────▶                                              │
 │ ◀── amounts[], vaults[]                                          │
 │                                                                  │
 │ liquidate(...) ───────────────────────────▶                      │
 │   OR liquidateWithLLP(...)                │                      │
 │                                           │── liquidationCall ──▶│
 │                                           │  (Spoke moves shares)│
 │                                           │                      │
 │                  direct mode:             │                      │
 │                  vault redeemed to        │                      │
 │                  BTC_REDEEM_KEY in same tx│                      │
 │                                                                  │
 │                  LLP mode:                                       │
 │                  vault escrowed in BTCVaultSwap, liquidator      │
 │                  receives WBTC immediately (drawn from Hub at    │
 │                  sell discount); arbitrageur later acquires.     │
 │                                                                  │
 │ ◀──────────────── tx receipt ────────────────────────────────────│
```

Direct mode redeems the seized vault to the liquidator's BTC key in the same
tx. LLP mode escrows the vault in BTCVaultSwap and immediately pays the
liquidator WBTC at a sell discount (drawn from the Hub); an arbitrageur
later pays the Hub debt + protocol fee to acquire the vault, which restores
the Hub draw.

## Environment Variables

```bash
# Required ---------------------------------------------------------------

# Private key of liquidator (needs debt tokens)
LIQUIDATOR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42069

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# AaveAdapter address
ADAPTER_ADDRESS=0x...

# AaveAdapterLens address
LENS_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Optional ---------------------------------------------------------------

# Comma-separated debt tokens. If unset, auto-discovered from the Spoke.
# DEBT_TOKEN_ADDRESSES=0xUSDC...,0xUSDT...

# Selects redemption mode. "true" → direct (calls liquidate); anything
# else → LLP escrow (calls liquidateWithLLP). Default: false.
# IS_DIRECT_REDEMPTION=false

# When IS_DIRECT_REDEMPTION=true, vault is redeemed to this BTC key.
# Default: bytes32(0). Required to be non-zero in direct mode.
# BTC_REDEEM_KEY=0x...

# When IS_DIRECT_REDEMPTION=false, the LLP (BTCVaultSwap) address.
# Default: address(0). Required to be non-zero in LLP mode.
# LLP_ADDRESS=0x...

# Poll interval (default: 10000 ms)
# POLLING_INTERVAL_MS=10000

# Receipt wait timeout (default: 120000 ms)
# TX_RECEIPT_TIMEOUT_MS=120000

# Metrics port (default: 9090)
# METRICS_PORT=9090
```

## CLI

```bash
pnpm liquidator:run        # poll mode (the only mode)
```

Any argv other than `poll` exits 1.

## Monitoring

The client exposes an HTTP server on `METRICS_PORT` (default 9090):

- `GET /health`, `GET /healthz` — health JSON. 200 for healthy/degraded,
  503 for unhealthy. Body: `{ status, uptime, lastPollAt, ponderReachable,
  rpcReachable, latestBlockNumber }`.
- `GET /ready`, `GET /readyz` — 200 only when both Ponder and RPC
  reachable; 503 otherwise.
- `GET /metrics` — Prometheus exposition.

The Ponder reachability probe hits `${PONDER_URL}/positions`, which returns
the full position table. Aggressive probe intervals will scan that table on
every check.

## Testing

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
```
