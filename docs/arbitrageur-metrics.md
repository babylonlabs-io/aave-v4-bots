# Metrics

Exposed at `GET /metrics` on port `9091` (configurable via `METRICS_PORT`).
Default Node.js process metrics are also collected.

## Arbitrageur Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrageur_vaults_acquired_total` | Counter | - | Total vaults acquired (one per successful `swapWbtcForVault`) |
| `arbitrageur_wbtc_spent_total` | Counter | - | Cumulative budgeted WBTC spend in satoshis (see note below) |
| `arbitrageur_wbtc_balance` | Gauge | - | Current arbitrageur WBTC balance (satoshis) |
| `arbitrageur_errors_total` | Counter | `type` | Errors by type (see below) |
| `arbitrageur_poll_duration_seconds` | Histogram | - | Poll cycle duration. Buckets: 0.1, 0.5, 1, 2, 5, 10, 30, 60 |
| `arbitrageur_last_poll_timestamp` | Gauge | - | Last poll unix timestamp (seconds) |

> **Note on `arbitrageur_wbtc_spent_total`.** The counter is incremented
> by the slippage-budgeted `currentDebt` value (the contract's
> `amountWbtcToAcquire`), not by the actual `amountWbtcIn` returned by
> the swap. The actual spend can be lower if interest/fees stayed below
> the budget; the metric over-attributes in that case.

## Error Types

`arbitrageur_errors_total{type="..."}` is incremented with one of the
following label values:

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception escaped the poll cycle |
| `ponder_fetch_error` | Failed to fetch `/escrowed-vaults` from Ponder |
| `vault_skipped` | Vault not in escrow at preview time, or `isProfitable=false` |
| `gas_estimation_failed` | `estimateContractGas` for the swap reverted |
| `tx_timeout` | Receipt wait exceeded `TX_RECEIPT_TIMEOUT_MS` |
| `swap_reverted` | Receipt status was `reverted` |
| `contract_revert` | `writeContract` rejected with a `ContractFunctionRevertedError` |
| `acquire_error` | Other unhandled exception during acquisition |

## Health Endpoints

| Endpoint | Status codes | Body |
|---|---|---|
| `GET /health`, `GET /healthz` | 200 for `healthy` or `degraded`, 503 for `unhealthy` | `{ "status", "uptime", "lastPollAt", "ponderReachable", "rpcReachable", "latestBlockNumber" }` |
| `GET /ready`, `GET /readyz` | 200 only when both Ponder and RPC reachable, else 503 | `{ "ready": true }` on success; full health body on 503 |
| `GET /metrics` | 200 | Prometheus text format |

`status` is `healthy` iff both Ponder and RPC are reachable, `degraded`
if exactly one is, and `unhealthy` if neither is. The Ponder probe
hits `${PONDER_URL}/escrowed-vaults`, which runs the on-chain
enrichment for every escrowed vault — aggressive probe intervals will
drive RPC traffic.
