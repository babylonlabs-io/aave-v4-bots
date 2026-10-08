# Liquidation Client

Polls the Ponder indexer for unhealthy positions and executes liquidations
against the AaveAdapter contract.

> **Execution modes.** Step 6 below ("Liquidate") goes through the process's one
> `Executor`. In **AUTO** mode (default) it signs + broadcasts. In **MANUAL** mode
> (`EXECUTION_MODE=MANUAL`) the bot is keyless: it persists a signed-tx proposal to the
> crash-safety store and notifies an operator, who broadcasts it with
> [`operator-cli`](../operator-cli/README.md). The risk gate, kill switch, and Postgres
> crash-safety store (`DATABASE_URL`) are opt-in — see the root
> [README](../../README.md#execution-modes) and `env.liquidator.example`.

## How It Works

1. **Discover reserves** — at boot, enumerates the Spoke's reserves in id order.
   The ids matter: the repay amount is charged to the token of the reserve id
   the Lens returns with it. Those a borrower can owe (borrowable, or still carrying debt) are
   what the signer holds and approves.
2. **Approve** — under `LIQUIDATION_FUNDING=inventory` (the default), once at
   boot, sets `MAX_UINT256` allowance on every token a borrower can owe and on
   WBTC for the AaveAdapter contract. WBTC approval is required because the
   adapter pulls the fairness payment and, in direct-redemption mode, the
   liquidation fee directly from `msg.sender` during liquidation. Under `flash` funding this step is a no-op — the bot
   moves none of its own tokens, so it grants no allowances.
3. **Poll** — fetches `/liquidatable-positions` from the indexer every
   `POLLING_INTERVAL_MS`.
4. **Estimate** — for each candidate, calls
   `AaveAdapterLiquidationPreview.estimateLiquidation(proxy)` to get
   `(uint256 debtReserveId, uint256 debtToCover, uint256 exitBtcFee,
   uint256 exitBtcFairnessPayment, bytes32 vaultId, uint256 amountCollateralToSeize)`.
   The Core Spoke allows one debt reserve per position, so there is one
   `debtReserveId`. The bot sets `wbtcPayment` to
   `exitBtcFee + exitBtcFairnessPayment` in direct mode and to
   `exitBtcFairnessPayment` alone in LLP mode, because the LLP pays the
   liquidation fee. `debtToCover` and `wbtcPayment` are bumped by 1%, rounding
   up, to absorb interest accrued between estimate and broadcast.
   `wbtcPayment` is both what the adapter pulls from `msg.sender` and the
   `maxExitBtcPayment` cap the call carries, so the bot needs sufficient WBTC
   balance and approval, and a payment that drifts past the buffer reverts
   on-chain with `ExcessiveExitBtcPayment` rather than being charged.
5. **Vet** — under `inventory` funding, simulates every candidate against the
   adapter and drops any that revert. Under `flash` funding this is a probe of
   `LiquidationRouter` that also returns the WBTC profit the candidate yields.
6. **Liquidate** — calls one of two adapter functions depending on
   `IS_DIRECT_REDEMPTION`. Both seize exactly one vault: the head of the
   borrower's ordered list.
   - `IS_DIRECT_REDEMPTION=true` →
     `AaveAdapter.liquidate(borrower, debtReserveId, debtToCover, maxExitBtcPayment, BTC_REDEEM_KEY)`.
     The seized vault is redeemed directly to `BTC_REDEEM_KEY`. The bot passes
     the buffered `wbtcPayment` as `maxExitBtcPayment`.
   - default (`false`) →
     `AaveAdapter.liquidateWithLLP(borrower, LLP_ADDRESS, debtReserveId, debtToCover, maxExitBtcPayment, [])`.
     The seized vault is escrowed in the LLP (BTCVaultSwap) for an arbitrageur
     to acquire later. The empty `requestedTokens` array puts no token or
     minimum-amount constraint on the LLP, which pays the liquidator WBTC.

Under `LIQUIDATION_FUNDING=flash` step 6 targets `LiquidationRouter.liquidate`
instead of the adapter. The router reads the Lens, borrows the position's debt
token, calls `liquidateWithLLP` on the bot's behalf with the fairness payment
as the cap, repays the venues from the seized collateral and sweeps the
remaining WBTC to its `owner` — which must be this bot's signer. It draws WBTC
only when there is a fairness payment; when WBTC is itself the debt token, it
borrows the debt and the fairness payment together through the one WBTC venue.

## Liquidation Flow

```
Bot          LiquidationPreview        AaveAdapter           Spoke / LLP
 │                   │                       │                     │
 │ estimateLiquidation()                                            │
 │ ──────────────────▶                                              │
 │ ◀── debtReserveId, debtToCover, exitBtcFee,                      │
 │     exitBtcFairnessPayment, vaultId                              │
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
later pays the Hub debt, capped at the vault's value minus the LLP's minimum
profit threshold, to acquire the vault. The acquisition closes the Hub debt:
it repays what the arbitrageur pays and reports any shortfall as a Hub deficit.

## Environment Variables

```bash
# Required ---------------------------------------------------------------

# Private key of liquidator (needs debt tokens under inventory funding; gas only under flash)
LIQUIDATOR_PRIVATE_KEY=0x...

# Ponder API URL
PONDER_URL=http://localhost:42069

# RPC URL
CLIENT_RPC_URL=http://localhost:8545

# AaveAdapter address
ADAPTER_ADDRESS=0x...

# AaveAdapterLiquidationPreview address
LENS_ADDRESS=0x...

# WBTC token address
WBTC_ADDRESS=0x...

# Optional ---------------------------------------------------------------

# Funding mode: inventory (default) repays from this signer's balances; flash
# repays through LiquidationRouter and needs no debt-token inventory at all.
# The four below are required together when LIQUIDATION_FUNDING=flash.
# See env.liquidator.example for the full explanation of each.
# LIQUIDATION_FUNDING=inventory
# LIQUIDATION_ROUTER_ADDRESS=0x...
# FLASH_SWAP_VENUE_ADDRESS=0x...
# FLASH_SWAP_POOLS=0xUSDC:0xWBTC:0xUSDC:3000:60
# WBTC_FLASH_LOAN_ADDRESS=0x...
# WBTC_FLASH_LOAN_VENUE=morpho
# FLASH_MAX_SLIPPAGE_BPS=2000

# Comma-separated debt tokens. If unset, auto-discovered from the Spoke.

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

The Ponder readiness probe hits `${PONDER_URL}/ready` — Ponder's own signal, 503 until historical
indexing completes. It says nothing about an indexer that finished backfilling and later stopped
advancing: that is the lag guard's job (`INDEXER_MAX_LAG_BLOCKS`). Probing a data route such as
`${PONDER_URL}/positions` instead would answer 200 in both cases, and returns
the full position table. Aggressive probe intervals will scan that table on
every check.

## Testing

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
```
