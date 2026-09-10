# Metrics

Exposed at `GET /metrics` on port `9091` (`METRICS_PORT`), with the default Node.js process
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

## Arbitrageur Metrics

All WBTC amounts are in satoshis.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrageur_vaults_acquired_total` | Counter | - | Vaults acquired, counted in AUTO receipt processing only. Executions confirmed later by reconcile, and every MANUAL execution, are not counted. For a complete total, read the chain or the persisted intents |
| `arbitrageur_wbtc_spent_total` | Counter | - | Sum of the pre-send preview cost (`amountWbtcToAcquire`) of those same acquisitions. Without the slippage buffer, and not the executed `amountWbtcIn` |
| `arbitrageur_funding_wbtc_balance` | Gauge | `owner` | WBTC held by the account that pays: the signer under `inventory`, the treasury under `router` |
| `arbitrageur_funding_wbtc_allowance` | Gauge | `owner` | WBTC the treasury has approved the router to spend. `router` only; the inventory approval to BTCVaultSwap is not exported |
| `arbitrageur_funding_wbtc_authorized` | Gauge | `owner` | WBTC held back for signed relay batches that are settled but still executable. `router` only. Capacity is `min(balance, allowance) - authorized`. A figure that stays high means acquisitions are abandoned after signing |
| `arbitrageur_wbtc_balance` | Gauge | - | The signer's WBTC. Under `router` this does not fund acquisitions |
| `arbitrageur_errors_total` | Counter | `type` | Errors by type (see below) |
| `arbitrageur_poll_duration_seconds` | Histogram | - | Poll cycle duration. Buckets: 0.1, 0.5, 1, 2, 5, 10, 30, 60 |
| `arbitrageur_last_poll_timestamp` | Gauge | - | Unix time (s) of the last completed cycle, whatever its outcome |

The three `arbitrageur_funding_*` gauges are refreshed only on a cycle where the indexer returned
at least one escrowed vault. They hold their last value through quiet periods, so pair them with
an on-chain balance check rather than treating a flat series as current.

With the optional liquidation engine enabled, the same endpoint also serves the `liquidator_*`
set in [liquidator-metrics.md](liquidator-metrics.md).

## Error Types

`arbitrageur_errors_total{type="..."}` takes one of:

| Label Value | Trigger |
|-------------|---------|
| `poll_error` | Exception escaped the poll cycle |
| `ponder_fetch_error` | Failed to fetch `/escrowed-vaults` |
| `vaults_unreadable` | The indexer answered but could not preview some escrowed vaults, for a reason other than the vault leaving escrow. Those vaults are missing from the list. Sustained, a vault or the RPC serving that read is persistently failing |
| `vault_skipped` | Vault not in escrow at preview time, or its previewed profit was zero |
| `risk_blocked` | Risk gate denied the action |
| `intent_in_flight` | A live persisted intent already exists for the vault |
| `gas_estimation_failed` | Gas estimation for the swap failed and the vault is still in escrow. Covers a revert and an RPC error alike; an estimate that reverts because the vault is gone counts as `race_lost` instead |
| `swap_send_error` | Executor failed or aborted while committing the swap |
| `tx_timeout` | Receipt wait exceeded `TX_RECEIPT_TIMEOUT_MS` |
| `swap_reverted` | Reverted with the vault still in escrow. Feeds the breaker |
| `race_lost` | The vault was gone before acquisition or after a reverted swap: another arbitrageur won. Breaker-exempt |
| `authorization_expired` | `router` only. Reverted with the vault still in escrow because the signed batch sat behind a stalled nonce past `ARBITRAGE_RELAY_DEADLINE_SECONDS`. Breaker-exempt. A run of these means the send queue is stalling: look at nonce gaps |
| `relay_executed_elsewhere` | `router` only. The router's event shows our authorization acquired the vault, but another submitter sent it and paid the gas. Raised either after our swap reverted on a vault already gone, or before we broadcast at all, since gas estimation exposes the signed batch to the RPC. The spend stays counted |
| `classification_error` | Something in receipt handling threw: a read that decides why a revert happened, or persisting the outcome after a settled receipt. An unclassifiable revert is counted as a genuine failure, the safe direction. The rest of the batch is still processed |
| `spend_check_error` | `router` only. The router's event could not be read, so whether our authorization paid is unknown. The WBTC stays counted as spent until the next balance refresh |
| `receipt_fetch_error` | No receipt. The transaction's fate is unknown; the intent stays live for reconcile |
| `contract_revert` | A contract revert escaped acquisition preparation (preview, gas estimate or send), logged with its name |
| `acquire_error` | Other unhandled exception during acquisition |

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
