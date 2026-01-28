# Metrics

Exposed at `GET /metrics` on port `9091` (configurable via `METRICS_PORT`).

## Arbitrageur Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrageur_vaults_acquired_total` | Counter | - | Total vaults acquired |
| `arbitrageur_wbtc_spent_total` | Counter | - | Total WBTC spent (satoshis) |
| `arbitrageur_wbtc_balance` | Gauge | - | Current WBTC balance (satoshis) |
| `arbitrageur_errors_total` | Counter | `type` | Errors by type |
| `arbitrageur_poll_duration_seconds` | Histogram | - | Poll cycle duration |
| `arbitrageur_last_poll_timestamp` | Gauge | - | Last poll unix timestamp |

## Error Types

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception in poll cycle |
| `ponder_fetch_error` | Failed to fetch from Ponder API |
| `gas_estimation_failed` | Gas estimation failed before tx |
| `tx_timeout` | Transaction receipt timeout |
| `acquire_error` | Failed to acquire vault |
| `swap_reverted` | Swap transaction reverted |
| `redeem_error` | Failed to redeem vault |
| `redeem_reverted` | Redeem transaction reverted |
| `contract_revert` | Contract call reverted |

## Health Endpoints

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{"status": "healthy\|degraded\|unhealthy", "uptime": <seconds>, "lastPollAt": "<ISO>", "ponderReachable": <bool>, "rpcReachable": <bool>, "latestBlockNumber": "<string>"}` |
| `GET /ready` | `{"ready": <bool>}` - 503 if dependencies unreachable |
| `GET /metrics` | Prometheus format |

