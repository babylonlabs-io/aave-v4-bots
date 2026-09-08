# Metrics

Exposed at `GET /metrics` on port `9090` (`METRICS_PORT`), with the default Node.js process
metrics. The kill switch is a separate authenticated server on `RISK_CONTROL_HOST:RISK_CONTROL_PORT`
when `RISK_CONTROL_TOKEN_REF` is set.

## Shared Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `eth_rpc_calls_total` | Counter | `method` | Outbound JSON-RPC attempts, one per HTTP request. A retried call counts once per attempt, which is what the provider bills |
| `submitter_send_total` | Counter | `result` | Broadcast attempts under private submission: `accepted`, `rejected`, `ambiguous` (relay unreachable or 5xx; the nonce stays fenced) |
| `relay_tx_status_total` | Counter | `status` | Relay status observations for private transactions, plus `sim_error` (our transaction is unviable) and `probe_error` (status API unreachable). Recorded only when the bot has to ask the relay, so not an inclusion counter |
| `indexer_lag_blocks` | Gauge | - | Blocks the indexer is behind the chain at the last check |
| `indexer_cycles_skipped_total` | Counter | - | Poll cycles skipped because the indexer was lagging or unreadable (`INDEXER_MAX_LAG_BLOCKS`; off when unset) |
| `indexer_halts_total` | Counter | - | Times sustained indexer lag halted the risk gate (`INDEXER_MAX_LAG_HALT_MS`) |

## Liquidator Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `liquidator_positions_checked` | Gauge | - | Positions checked in the last poll |
| `liquidator_positions_liquidatable` | Gauge | - | Liquidatable positions found in the last poll |
| `liquidator_liquidations_total` | Counter | - | Confirmed liquidations by this process |
| `liquidator_liquidations_failed_total` | Counter | - | On-chain reverts classified as genuine failures (`tx_reverted`). Not `race_lost`, and not receipt failures |
| `liquidator_simulations_failed_total` | Counter | - | Inventory: simulations rejected before broadcast. Flash: probes that were unavailable or unprofitable |
| `liquidator_token_balance` | Gauge | `token`, `address` | Signer balance per ERC-20 in whole tokens. `token` is the symbol, `address` the token contract. Debt tokens and WBTC only; ETH is not exported. Under `LIQUIDATION_FUNDING=flash` these are not funding capacity, see below |
| `liquidator_errors_total` | Counter | `type` | Errors by type (see below) |
| `liquidator_poll_duration_seconds` | Histogram | - | Poll cycle duration. Buckets: 0.1, 0.5, 1, 2, 5, 10, 30, 60 |
| `liquidator_last_poll_timestamp` | Gauge | - | Unix time (s) of the last completed cycle, whatever its outcome |

### Alerting on `liquidator_token_balance`

- `inventory`: the balances are working capital. A debt-token balance near zero means the bot
  skips positions it cannot afford. Alert on it.
- `flash`: `LiquidationRouter` borrows every debt token and repays it in the same transaction, so
  a zero debt-token balance is the steady state. Watch WBTC rising (profit is swept to the signer)
  and alert on `liquidator_liquidations_failed_total` instead.

## Error Types

`liquidator_errors_total{type="..."}` takes one of:

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception escaped the poll cycle: candidate fetch, simulation or funding. Inventory approvals may already have been broadcast |
| `batch_error` | Exception escaped the send batch: broadcasting, receipt waiting or outcome recording. Transactions may be in flight |
| `ponder_fetch_error` | Failed to fetch `/liquidatable-positions` |
| `positions_unscanned` | The indexer had no answer for part of the position table: a batch of `estimateLiquidation` calls failed whole, or probes reverted for a reason other than the position being healthy. The cycle acts on what it saw. Sustained, the table has outgrown one batch's gas budget, the RPC refuses the batch, or a contract the lens reads is faulting (the indexer log names the revert) |
| `lens_estimate_error` | `Lens.estimateLiquidation` reverted for a candidate |
| `flash_probe_error` | The flash probe threw for a candidate. A malfunction, not a "not fundable" verdict (`flash` only) |
| `router_balance_read_error` | The router's WBTC balance could not be read, so the cycle was skipped: every quote is net of that balance (`flash` only) |
| `risk_blocked` | Risk gate denied the action |
| `intent_in_flight` | A live persisted intent already exists for the position |
| `tx_send_error` | Failed to broadcast |
| `tx_reverted` | Reverted with the position still open. Bumps `liquidations_failed_total` and feeds the breaker |
| `race_lost` | Reverted, but the position was already gone. Ordinary competition: breaker-exempt |
| `receipt_fetch_error` | No receipt. The transaction's fate is unknown; the intent stays live for reconcile. Breaker-exempt |

## Health Endpoints

| Endpoint | Status codes | Body |
|---|---|---|
| `GET /health`, `GET /healthz` | 200 for `healthy` or `degraded`, 503 for `unhealthy` | `{ "status", "uptime", "lastPollAt", "ponderReachable", "rpcReachable", "latestBlockNumber" }` |
| `GET /ready`, `GET /readyz` | 200 only when both Ponder and RPC are reachable, else 503 | `{ "ready": true }`, or the health body on 503 |
| `GET /metrics` | 200 | Prometheus text format |

`status` is `healthy` when both Ponder and RPC are reachable, `degraded` when exactly one is, and
`unhealthy` when neither is. The Ponder probe hits `${PONDER_URL}/ready`: 503 during historical
indexing, 200 after. That flag is one-way, so an indexer that later stops advancing still answers
200. Falling behind is caught by the lag guard (`INDEXER_MAX_LAG_BLOCKS`, off by default), which
skips cycles and eventually halts the risk gate rather than failing this probe.
