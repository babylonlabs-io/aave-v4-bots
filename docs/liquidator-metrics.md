# Metrics

Exposed at `GET /metrics` on port `9090` (configurable via `METRICS_PORT`).
Default Node.js process metrics are also collected. The risk-control kill
switch is a separate authenticated server on `RISK_CONTROL_HOST:RISK_CONTROL_PORT`
when `RISK_CONTROL_TOKEN_REF` is set; it is not mounted on the metrics port.

## Shared Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `eth_rpc_calls_total` | Counter | `method` | Outbound JSON-RPC calls, incremented by the instrumented HTTP transport |

## Liquidator Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `liquidator_positions_checked` | Gauge | - | Positions checked in the last poll |
| `liquidator_positions_liquidatable` | Gauge | - | Liquidatable positions found in the last poll |
| `liquidator_liquidations_total` | Counter | - | Total successful liquidations |
| `liquidator_liquidations_failed_total` | Counter | - | Total failed liquidation attempts (revert or receipt-fetch failure) |
| `liquidator_simulations_failed_total` | Counter | - | Total simulations that reverted before broadcast |
| `liquidator_token_balance` | Gauge | `token`, `address` | Liquidator wallet balance per token (debt tokens + WBTC). Under `LIQUIDATION_FUNDING=flash` these are **not** funding capacity — see below |
| `liquidator_errors_total` | Counter | `type` | Errors by type (see below) |
| `liquidator_poll_duration_seconds` | Histogram | - | Poll cycle duration. Buckets: 0.1, 0.5, 1, 2, 5, 10, 30, 60 |
| `liquidator_last_poll_timestamp` | Gauge | - | Last poll unix timestamp (seconds) |

### Alerting on `liquidator_token_balance`

The bot reports these balances in both funding modes, but they mean different
things:

- **`LIQUIDATION_FUNDING=inventory`** — they are working capital. A debt-token
  balance falling toward zero means the bot will start skipping positions it
  cannot afford, so alert on it.
- **`LIQUIDATION_FUNDING=flash`** — they are not. `LiquidationRouter` borrows
  every debt token and repays it within the same transaction, so a zero
  debt-token balance is the expected steady state, not an incident. Alerting on
  it here produces a permanently firing alert. Watch WBTC *rising* (profit is
  swept to the signer) and alert on `liquidator_liquidations_failed_total`
  instead.

ETH is worth alerting on in both modes — it is the one balance the bot always
spends.

## Error Types

`liquidator_errors_total{type="..."}` is incremented with one of the
following label values:

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception escaped the poll cycle |
| `ponder_fetch_error` | Failed to fetch `/liquidatable-positions` from Ponder |
| `lens_estimate_error` | `Lens.estimateLiquidation` reverted for a candidate |
| `risk_blocked` | Risk gate denied the action before execution |
| `intent_in_flight` | A live persisted intent/proposal already exists for the position |
| `tx_send_error` | Failed to broadcast the liquidation transaction |
| `tx_reverted` | Transaction reverted on-chain (also bumps `liquidations_failed_total`) |
| `receipt_fetch_error` | Failed to fetch transaction receipt (also bumps `liquidations_failed_total`) |

## Health Endpoints

| Endpoint | Status codes | Body |
|---|---|---|
| `GET /health`, `GET /healthz` | 200 for `healthy` or `degraded`, 503 for `unhealthy` | `{ "status", "uptime", "lastPollAt", "ponderReachable", "rpcReachable", "latestBlockNumber" }` |
| `GET /ready`, `GET /readyz` | 200 only when both Ponder and RPC reachable, else 503 | `{ "ready": true }` on success; full health body on 503 |
| `GET /metrics` | 200 | Prometheus text format |

`status` is `healthy` iff both Ponder and RPC are reachable, `degraded`
if exactly one is, and `unhealthy` if neither is. The Ponder probe
hits `${PONDER_URL}/positions`, which scans every row in the indexer's
position table — a non-trivial cost on aggressive probe intervals.
