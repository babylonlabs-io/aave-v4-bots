# Metrics

Exposed at `GET /metrics` on port `9090` (configurable via `METRICS_PORT`).

## Liquidator Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `liquidator_positions_checked` | Gauge | - | Positions checked in the last poll |
| `liquidator_positions_liquidatable` | Gauge | - | Liquidatable positions found in the last poll |
| `liquidator_liquidations_total` | Counter | - | Total successful liquidations |
| `liquidator_liquidations_failed_total` | Counter | - | Total failed liquidation attempts |
| `liquidator_simulations_failed_total` | Counter | - | Total simulations that failed |
| `liquidator_token_balance` | Gauge | `token`, `address` | Current token balance (debt tokens + WBTC) |
| `liquidator_errors_total` | Counter | `type` | Errors by type |
| `liquidator_poll_duration_seconds` | Histogram | - | Poll cycle duration |
| `liquidator_last_poll_timestamp` | Gauge | - | Last poll unix timestamp |

## Error Types

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception in poll cycle |
| `ponder_fetch_error` | Failed to fetch from Ponder API |
| `lens_estimate_error` | Failed to estimate liquidation via lens contract |
| `tx_send_error` | Failed to send liquidation transaction |
| `tx_reverted` | Transaction reverted on-chain |
| `receipt_fetch_error` | Failed to fetch transaction receipt |

## Health Endpoints

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{"status": "healthy\|degraded\|unhealthy", "uptime": <seconds>, "lastPollAt": "<ISO>", "ponderReachable": <bool>, "rpcReachable": <bool>, "latestBlockNumber": "<string>"}` |
| `GET /ready` | `{"ready": <bool>}` - 503 if dependencies unreachable |
| `GET /metrics` | Prometheus format |
