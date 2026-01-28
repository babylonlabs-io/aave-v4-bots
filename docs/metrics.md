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
| `liquidator_vaults_seized_total` | Counter | - | Total vaults seized from liquidations |
| `liquidator_vaults_swapped_total` | Counter | - | Total vaults swapped for WBTC |
| `liquidator_wbtc_received_total` | Counter | - | Total WBTC received from swaps (satoshis) |
| `liquidator_token_balance` | Gauge | `token`, `address` | Current token balance (debt tokens + WBTC) |
| `liquidator_errors_total` | Counter | `type` | Errors by type |
| `liquidator_poll_duration_seconds` | Histogram | - | Poll cycle duration |
| `liquidator_last_poll_timestamp` | Gauge | - | Last poll unix timestamp |

## Error Types

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception in poll cycle |
| `ponder_fetch_error` | Failed to fetch from Ponder API |
| `tx_send_error` | Failed to send liquidation transaction |
| `tx_reverted` | Transaction reverted or receipt failed |
| `swap_error` | Failed to send or confirm vault swap |

## Health Endpoints

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{"status": "healthy\|degraded\|unhealthy", "uptime": <seconds>, "lastPollAt": "<ISO>", "ponderReachable": <bool>, "rpcReachable": <bool>, "latestBlockNumber": "<string>"}` |
| `GET /ready` | `{"ready": <bool>}` - 503 if dependencies unreachable |
| `GET /metrics` | Prometheus format |
