# Metrics

Exposed at `GET /metrics` on port `9091` (configurable via `METRICS_PORT`).
Default Node.js process metrics are also collected. The risk-control kill
switch is a separate authenticated server on `RISK_CONTROL_HOST:RISK_CONTROL_PORT`
when `RISK_CONTROL_TOKEN_REF` is set; it is not mounted on the metrics port.

## Shared Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `eth_rpc_calls_total` | Counter | `method` | Outbound JSON-RPC **attempts**, incremented by the instrumented HTTP transport. Counted per HTTP request, so a call the transport retries increments once per attempt — which is what the provider bills, and what makes a flapping endpoint visible |

## Arbitrageur Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrageur_vaults_acquired_total` | Counter | - | Total vaults acquired (one per successful `swapWbtcForVault`) |
| `arbitrageur_wbtc_spent_total` | Counter | - | Cumulative budgeted WBTC spend in satoshis (see note below) |
| `arbitrageur_funding_wbtc_balance` | Gauge | `owner` | WBTC held by the account that **pays** for acquisitions. Under `ARBITRAGE_FUNDING=inventory` that is the signer; under `router` it is the treasury, and the signer's own balance is not the one to watch |
| `arbitrageur_funding_wbtc_allowance` | Gauge | `owner` | WBTC the payer has approved the router to spend. Only emitted under `ARBITRAGE_FUNDING=router` — inventory funding has nothing to approve |
| `arbitrageur_funding_wbtc_authorized` | Gauge | `owner` | WBTC held back for signed relay batches that are settled but still executable. Only emitted under `ARBITRAGE_FUNDING=router`. The bot may commit `min(balance, allowance) − authorized`, so this is what explains a capacity below both. It should fall back to zero as batches expire or execute; a figure that stays high means acquisitions are being abandoned after signing |
| `arbitrageur_wbtc_balance` | Gauge | - | The **signer's** WBTC balance (satoshis). Under router funding this is not what funds acquisitions — see the two gauges above |
| `arbitrageur_errors_total` | Counter | `type` | Errors by type (see below) |
| `arbitrageur_poll_duration_seconds` | Histogram | - | Poll cycle duration. Buckets: 0.1, 0.5, 1, 2, 5, 10, 30, 60 |
| `arbitrageur_last_poll_timestamp` | Gauge | - | Last poll unix timestamp (seconds) |

When `ADAPTER_ADDRESS` and `LENS_ADDRESS` enable the optional liquidation
engine, this same endpoint also exposes the `liquidator_*` metrics documented
in `docs/liquidator-metrics.md`.

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
| `vaults_unreadable` | The indexer answered, but could not read some escrowed vaults — their live preview reverted for a reason other than the vault having left escrow. Those vaults are missing from the list, so the cycle acted on an incomplete escrow. Sustained, it means a vault (or an RPC endpoint serving that read) is persistently failing, and those vaults are never acquired |
| `vault_skipped` | Vault not in escrow at preview time, or its previewed profit was zero |
| `risk_blocked` | Risk gate denied the action before execution |
| `intent_in_flight` | A live persisted intent/proposal already exists for the vault |
| `gas_estimation_failed` | `estimateContractGas` for the swap reverted |
| `swap_send_error` | Executor failed or aborted while committing the swap |
| `tx_timeout` | Receipt wait exceeded `TX_RECEIPT_TIMEOUT_MS` |
| `swap_reverted` | Receipt status was `reverted` and the vault is still in escrow |
| `tx_replaced` | Another transaction took our swap's nonce and mined in its place — a cancellation, a repricing, or a send by another process holding the key. The receipt belongs to that transaction, so it says nothing about our acquisition: the outcome is unknown, it is breaker-exempt, and under `ARBITRAGE_FUNDING=router` the signed batch stays held until it expires or is seen executing |
| `race_lost` | The vault was gone before acquisition (gas estimation) or after a reverted swap — another arbitrageur won with their own funds. Ordinary competition: does not feed the breaker |
| `authorization_expired` | `ARBITRAGE_FUNDING=router` only. The swap reverted with the vault still in escrow, because the signed batch sat behind a stalled nonce for longer than `ARBITRAGE_RELAY_DEADLINE_SECONDS`. Nothing moved and nothing was refused on its merits, so it is breaker-exempt. A run of these means the send queue is stalling — look at nonce gaps, not at the market |
| `relay_executed_elsewhere` | `ARBITRAGE_FUNDING=router` only. Our swap reverted on a vault already gone, and the router's own event shows **our** authorization is what acquired it — another send of the same signed batch got there first. The vault reached our keeper and the treasury paid, so the spend stays counted. Against a router that relays only for its signer this means one of our own sends; against one that relays for anyone, it can be a third party's |
| `classification_error` | A read that decides *why* a reverted acquisition failed did not answer. The revert is then counted as a genuine failure, which is the safe direction: a breaker a flaky endpoint can silence is not one. Also covers a receipt whose classification threw outright, in which case the rest of the batch is still classified |
| `spend_check_error` | `ARBITRAGE_FUNDING=router` only. The router's own event could not be read, so whether our authorization paid for the vault is unknown. Its WBTC stays counted as spent until the next balance refresh — missing an outflow that happened would let the same balance be committed twice |
| `receipt_fetch_error` | Failed to fetch transaction receipt; the transaction's fate is unknown and the intent stays live for reconcile |
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
hits `${PONDER_URL}/ready`, Ponder's own readiness signal: 503 while historical
indexing is still running, 200 once it completes. The flag is one-way, so an
indexer that finishes backfilling and later stops advancing still answers 200
here; falling behind the chain is caught by the lag guard
(`INDEXER_MAX_LAG_BLOCKS`), which halts the risk gate. Probing a data route
instead would additionally run the on-chain enrichment for every escrowed
vault, so aggressive probe intervals would drive RPC traffic.
