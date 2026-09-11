# Arbitrageur Operation Guide

Operation of the arbitrageur service for the Aave v4 integration with Babylon's Trustless
Bitcoin Vaults protocol.

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Requirements](#2-system-requirements)
3. [Architecture Overview](#3-architecture-overview)
4. [Installation](#4-installation)
5. [Configuration](#5-configuration)
6. [Wallet Setup](#6-wallet-setup)
7. [Starting the Service](#7-starting-the-service)
8. [Operations](#8-operations)
9. [Vault Acquisition](#9-vault-acquisition)
10. [Incident: signing key compromised](#10-incident-signing-key-compromised)
11. [Troubleshooting](#11-troubleshooting)

## 1. Introduction

The service monitors BTC vaults escrowed in BTCVaultSwap (the LLP) and acquires them at a discount
for WBTC. Liquidators escrow seized vaults there through `liquidateWithLLP`.

| Component | Description |
|-----------|-------------|
| **Ponder Indexer** | Indexes `AddedVault` and `RemovedVault`, previews each escrowed vault on chain, and serves `/escrowed-vaults` |
| **Arbitrageur Client** | Polls the indexer, evaluates profitability, and executes acquisitions |

A vault keeper daemon must be running to complete redemptions. The protocol requires every entity
that may claim a vault to pre-sign transactions at vault creation, so the keeper set is
permissioned by the contract admin.

## 2. System Requirements

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| Ponder Indexer | 2 vCPUs | 4 GB | 20 GB SSD |
| Arbitrageur Client | 1 vCPU | 1 GB | 10 GB SSD |
| PostgreSQL | 2 vCPUs | 4 GB | 50 GB SSD |

External services: an Ethereum RPC endpoint and PostgreSQL 17.

| Port | Purpose |
|------|---------|
| 42070 | Ponder indexer API |
| 9091 | Metrics, health, and readiness |
| 9095 | Kill switch (optional, loopback by default) |
| 5433 | PostgreSQL |

## 3. Architecture Overview

```
Ethereum RPC ──┬──▶ Ponder Indexer ──▶ /escrowed-vaults (with live preview)
               │         │
               │         ▼
               └──▶ Arbitrageur Client
                     - AUTO: signs and broadcasts
                     - MANUAL: writes proposals for operator-cli
                     - inventory: swapWbtcForVault[OnBehalf] on BTCVaultSwap
                     - router: signed authorization through ArbitrageRouter
                     - optional: also runs the liquidation engine
                     - serves /metrics, /health, /ready
```

**Optional liquidation engine.** With `ADAPTER_ADDRESS` and `LENS_ADDRESS` set, the same process
also runs the liquidation engine. Both engines share one signer, executor, nonce sequence, token
balance and risk gate: a halt or a tripped breaker stops both. The indexer must then index the
position side too: set `SPOKE_ADDRESS`, `ADAPTER_ADDRESS` and `LENS_ADDRESS` in its env. See the
[Liquidator Operation Guide](./liquidator-operation-guide.md) for that pipeline.

## 4. Installation

### 4.1. Prerequisites

- Node.js 20 or 22 (the Docker images use 22)
- pnpm 9.13.2
- PostgreSQL 17
- A registered vault keeper (see §1)
- Foundry, only to deploy the router (router funding)

### 4.2. Native Installation

```bash
git clone https://github.com/babylonlabs-io/aave-v4-bots.git
cd aave-v4-bots
pnpm install
```

Key paths:

```
services/arbitrageur/     # bot composition root
services/operator-cli/    # MANUAL-mode operator tool
services/ponder/          # indexer (shared with the liquidator)
contracts/                # ArbitrageRouter
.env.arbitrageur          # bot configuration
.env.arbitrageur.indexer  # indexer configuration
docker-compose.yml
```

### 4.3. Docker Installation

Compose builds the images from `docker/*.Dockerfile`:

```bash
docker compose build arbitrageur-ponder arbitrageur-bot
```

`build` needs no configuration. `docker compose up` reads `.env.arbitrageur` and
`.env.arbitrageur.indexer` and fails if either is missing, so create them first (§5.1).

### 4.4. Router contract (router funding only)

Skip this under `ARBITRAGE_FUNDING=inventory`.

Router funding moves the WBTC off the signing key: a treasury holds it, and the bot only signs
an EIP-712 authorization. The router relays a batch only for its own signer, so the authorization
is of no use to anyone else who sees it. The bot pays the gas for every acquisition from the
signing account. Deploy the router once:

```bash
git submodule update --init --recursive

export ARBITRAGE_ROUTER_SIGNER=0x...   # this bot's signer. Authorizes acquisitions, holds no funds
export ARBITRAGE_ROUTER_PAYER=0x...    # the treasury
export WBTC_ADDRESS=0x...              # must match the LLP's WBTC
export DEPLOYER_PRIVATE_KEY=0x...
export RPC_URL=https://...

forge script scripts/DeployArbitrageRouter.s.sol:DeployArbitrageRouter \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

The script prints the router address. The treasury then approves it. The bot cannot do this, and
boot fails without it:

```bash
export ROUTER=0x...   # the ArbitrageRouter the script printed
export AMOUNT=...     # WBTC base units (8 decimals): 100000000 = 1 WBTC

cast send "$WBTC_ADDRESS" "approve(address,uint256)" "$ROUTER" "$AMOUNT" \
  --rpc-url "$RPC_URL" --private-key "$TREASURY_KEY"
```

Approve working capital, not an unlimited amount. `vaultSwap` is an argument to each signed call,
so a compromised signer can direct the whole allowance into a contract of its choosing. The
approval is the blast radius.

At boot the bot reads `signer`, `payer` and `wbtc` from the router. It fails if `signer` is not
its key, if `payer` is its key, if `wbtc` differs from `WBTC_ADDRESS`, or if the payer holds no
WBTC or no allowance. All three are immutable: a mismatch is a redeploy.

Router funding is rejected under `EXECUTION_MODE=MANUAL`. The authorization needs a key the bot
holds.

## 5. Configuration

### 5.1. Environment Files

| File | Used by |
|------|---------|
| `.env.arbitrageur` | The bot. Holds the key, risk and submission settings |
| `.env.arbitrageur.indexer` | The indexer. Holds indexing settings only, and no secrets |

```bash
cp env.arbitrageur.example         .env.arbitrageur
cp env.arbitrageur.indexer.example .env.arbitrageur.indexer

# Native only. Ponder reads .env.local from its own directory. Docker reads the root file directly.
cp .env.arbitrageur.indexer services/ponder/.env.local
```

Keep `VAULT_SWAP_ADDRESS` and the database in step between the two files.

### 5.2. Ponder Indexer Configuration

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `PONDER_RPC_URL` | RPC for indexing. May differ from the bot's | Yes | |
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap | Yes | |
| `DATABASE_URL` | PostgreSQL connection string. Ponder falls back to an embedded PGlite database when it is unset, which these guides do not use | Yes | |
| `DATABASE_SCHEMA` | Schema for Ponder's tables. `ponder start` requires it | Yes | |
| `SPOKE_ADDRESS`, `ADAPTER_ADDRESS`, `LENS_ADDRESS` | Position indexing for the optional liquidation engine. Set all or none | liquidation | |
| `POSITION_PROBE_CHUNK_SIZE` | See the liquidator guide | No | `25` |
| `CHAIN_ID` | Network chain ID | No | `1` |
| `START_BLOCK` | First block to index | No | `0` |
| `PONDER_POLLING_INTERVAL` | Block poll interval (ms) | No | `4000` |
| `PONDER_PORT` | API port. The `arbitrageur:indexer*` scripts and Compose both set it themselves, so a value here only applies when you run Ponder directly. Compose publishes the host port as `ARBITRAGEUR_PONDER_PORT` | No | `42070` |
| `MULTICALL3_ADDRESS` | Multicall3 for the API's batched reads. Falls back to single reads when absent on chain | No | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| `CONFIG_SECRET_ID` | AWS Secrets Manager id holding `PONDER_RPC_URL` and `DATABASE_URL` as JSON, for values not set in the env | No | |

### 5.3. Arbitrageur Client Configuration

Minimal `.env.arbitrageur`:

```bash
PONDER_URL=http://localhost:42070
CLIENT_RPC_URL=https://...
VAULT_SWAP_ADDRESS=0x...
WBTC_ADDRESS=0x...
ARBITRAGEUR_PRIVATE_KEY=0x...
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder
```

Everything else has a default, listed in the tables below. Under Docker, `PONDER_URL` and
`METRICS_PORT` are set by Compose, and `DATABASE_URL` must point at `arbitrageur-postgres:5432`,
not `localhost`.

**Core**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `PONDER_URL` | Indexer API endpoint | Yes | |
| `CLIENT_RPC_URL` | RPC for execution | Yes | |
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap | Yes | |
| `WBTC_ADDRESS` | WBTC token | Yes | |
| `VAULT_KEEPER_ADDRESS` | Registered keeper the vault is redeemed to, via `swapWbtcForVaultOnBehalf`. Set it when the executor is not a keeper (a Safe, or a treasury). Unset: the executor must be a keeper. Point it only at a keeper you control; the BTC lands there while the WBTC leaves the bot | router | |
| `MAX_SLIPPAGE_BPS` | Ceiling above the previewed cost the bot authorizes. Max `10000` | No | `100` |
| `POLLING_INTERVAL_MS` | Poll interval | No | `30000` |
| `VAULT_PROCESSING_DELAY_MS` | Throttle between broadcasts, for rate-limited RPCs. `0` is off | No | `0` |
| `TX_RECEIPT_TIMEOUT_MS` | Receipt wait per transaction | No | `120000` |
| `RETRY_MAX_ATTEMPTS` | Attempts per read, indexer and RPC | No | `3` |
| `RETRY_INITIAL_DELAY_MS` | First retry delay | No | `1000` |
| `RETRY_MAX_DELAY_MS` | Retry delay ceiling. Bounds indexer reads only; viem runs its own RPC schedule | No | `30000` |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` | No | `info` |
| `METRICS_PORT` | Metrics and health server port | No | `9091` |
| `METRICS_HOST` | Interface the metrics server binds. `/metrics` is unauthenticated and carries the signer and treasury addresses, balances and allowance, so bind it to the scraper's interface where no network policy applies | No | all interfaces |

**Acquisition funding**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `ARBITRAGE_FUNDING` | `inventory` pays from the signer's WBTC. `router` has the treasury pay through `ArbitrageRouter`. Router variables without `router` fail at boot | No | `inventory` |
| `ARBITRAGE_ROUTER_ADDRESS` | The deployed router (§4.4) | router | |
| `ARBITRAGE_RELAY_DEADLINE_SECONDS` | How long a signed batch stays valid, in chain seconds. Range 1 to 300. The router has no nonce, so a signed batch stays executable by this bot's signer until it expires, whether or not the transaction that carried it landed | No | `120` |

**Optional liquidation engine**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `ADAPTER_ADDRESS`, `LENS_ADDRESS` | Enable the engine. Set both or neither | liquidation | |
| `LIQUIDATION_POLLING_INTERVAL_MS` | Its own poll interval | No | `12000` |
| `IS_DIRECT_REDEMPTION`, `BTC_REDEEM_KEY`, `LLP_ADDRESS` | Redemption mode, as on the liquidator | liquidation | `false` |
| `LIQUIDATION_FUNDING` and the flash variables | As on the liquidator. `flash` without the engine is rejected | No | `inventory` |

See the [liquidator guide](./liquidator-operation-guide.md#53-liquidation-client-configuration)
for each variable.

**Signer, secrets and execution mode**

Identical to the liquidator's table, with `ARBITRAGEUR_PRIVATE_KEY` as the default key ref. See
[§5.3 there](./liquidator-operation-guide.md#53-liquidation-client-configuration). Run one AUTO
process per signer; use this dual-engine process when both engines must share a key.

**Indexer liveness**

`INDEXER_MAX_LAG_BLOCKS`, `INDEXER_MAX_LAG_HALT_MS` (`60000`), `INDEXER_READY_TIMEOUT_MS`, as on
the liquidator. One guard covers both engines.

**Risk gate**

As on the liquidator, with two differences:

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `RISK_MIN_PROFIT` | Floor in sats on the worst case the transaction authorizes: vault BTC minus `maxWbtcIn`. Rejected at boot when the liquidation engine is on and inventory-funded. Unset is not a floor of zero: a vault can preview profitably while `maxWbtcIn` exceeds its value, and the bot signs it. `RISK_MIN_PROFIT=0` makes the worst case non-negative | No | |
| `RISK_MAX_IN_FLIGHT` | Cap across both engines | No | unlimited |

### 5.4. Execution Modes

`AUTO` resolves one signer, shares it across both engines, signs and broadcasts, and waits for
receipts.

`MANUAL` is keyless. It requires `DATABASE_URL`, `MANUAL_EXECUTOR_ADDRESS` and
`MANUAL_EXECUTOR_KIND`. It refuses to boot with `SIGNER_SOURCE=aws`, `SIGNER_KEY_REF`,
`KMS_KEY_ID`, `SIGNER_ADDRESS`, or a populated signing-key env var. It writes content-hashed
proposals to the StateStore and notifies. The operator acts on them with `operator-cli`, see the
[liquidator guide §8.3](./liquidator-operation-guide.md#83-manual-proposals). Filter with
`list --action vault-acquisition`; inventory mode also emits `approval` proposals that must be
signed first.

### 5.5. Private submission

Off by default. `SUBMITTER=public` broadcasts to the node's mempool, where searchers watch.
`SUBMITTER=flashbots-protect` submits privately. AUTO only: MANUAL is rejected at boot, because
the operator's wallet chooses its own route.

| Variable | Required | Default |
|---|---|---|
| `SUBMITTER` | no | `public` |
| `FLASHBOTS_PROTECT_URL` | private | e.g. `https://rpc.flashbots.net/fast` |
| `FLASHBOTS_STATUS_URL` | no | `https://protect.flashbots.net` |
| `PRIVATE_MIN_PRIORITY_FEE_WEI` | private | none, on purpose |
| `PRIVATE_RELAY_HORIZON_BLOCKS` | no | `25`. Minimum nonce fence in blocks, max `7200`. With the status URL on Protect, a value below its ~25-block window fails at boot |
| `PRIVATE_RECLAIM_MARGIN_BLOCKS` | no | `3`. Reorg headroom past the fence, max `7200` |
| `PRIVATE_SUBMIT_TIMEOUT_MS` | no | `8000`. The submit holds the nonce lock, so keep it inside one poll cycle |
| `PRIVATE_STATUS_TIMEOUT_MS` | no | `2000` |

Boot fails rather than degrading when:

- `DATABASE_URL` is unset. A private transaction is invisible to the node, so persisted intents
  are the only nonce fence.
- `PRIVATE_MIN_PRIORITY_FEE_WEI` is unset. Flashbots drops transactions builders have no reason
  to include, and a competitive tip is a market condition. Every private transaction is signed
  with at least this tip.
- `FLASHBOTS_PROTECT_URL` or `PRIVATE_MIN_PRIORITY_FEE_WEI` is set under `SUBMITTER=public`, or
  either of those, or `SUBMITTER=flashbots-protect`, is set under `EXECUTION_MODE=MANUAL`. The
  remaining relay variables carry defaults, so they are accepted and ignored outside private mode.

**Nonce fence.** A dropped private transaction holds its nonce until the chain passes the larger
of the relay's stated deadline and `head + PRIVATE_RELAY_HORIZON_BLOCKS`, plus the margin. A relay
deadline more than 7200 blocks past head is capped. Later transactions queue behind it. This is
self-healing. If `eth_getTransactionCount` stops advancing while the bot keeps recording intents,
look for `Relay status probe failed` in the logs: an unreachable status endpoint keeps every nonce
fenced until its horizon.

**Accepted risk: the relay is trusted to stop offering a transaction.** A signed transaction has
no expiry, so nothing on chain forces the relay to drop it after its deadline. Releasing the nonce
relies on the relay honouring the deadline it reported or, when it reports none, on
`PRIVATE_RELAY_HORIZON_BLOCKS` matching the relay you use. The window, the margin and the cap bound
this exposure. Only consuming the nonce on chain removes it, and this bot does not do that.

**Judge the trade-off from your own metrics.** Private submission narrows who can include you
(`/fast` fans out to all registered builders) and aligns to block boundaries.

| Metric | Meaning |
|---|---|
| `submitter_send_total{result="accepted"}` | The relay took the transaction |
| `submitter_send_total{result="rejected"}` | The relay refused it: malformed call or bad fee |
| `submitter_send_total{result="ambiguous"}` | Relay unreachable or 5xx. The nonce stays fenced |
| `relay_tx_status_total{status="sim_error"}` | Your transaction is unviable. Check the fee floor and the call |
| `relay_tx_status_total{status="probe_error"}` | Status API unreachable. Nonces stay fenced |

Measure inclusion with `arbitrageur_vaults_acquired_total` and `liquidator_liquidations_total`.
`relay_tx_status_total` is only recorded when the bot has to ask the relay, so it is not an
inclusion counter.

### 5.6. Contract Addresses

Testnet addresses are provided during onboarding.

| Variable | Contract |
|----------|----------|
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap. `swapWbtcForVault`, `previewEscrowedVaults` |
| `WBTC_ADDRESS` | WBTC token |

## 6. Wallet Setup

**`inventory`**

| Asset | Held by | Purpose |
|-------|---------|---------|
| ETH | signer | Gas |
| WBTC | signer | Acquisitions. Keep a buffer for several at once |

**`router`**

| Asset | Held by | Purpose |
|-------|---------|---------|
| ETH | signer | Gas |
| WBTC | treasury (`payer`) | Acquisitions, plus an allowance to the router |

Capacity under router funding is `min(treasury balance, allowance)` minus WBTC held for signed
batches that are still executable. An exhausted allowance stops acquisitions exactly like an
empty treasury, and only the treasury can raise it.

An inventory-funded liquidation engine in the same process still spends the signer's debt tokens
and WBTC.

Monitoring:

- ETH: the bot does not export its ETH balance. Use an external balance monitor.
- WBTC: alert on `arbitrageur_funding_wbtc_balance`. It follows whichever account pays.
  `arbitrageur_wbtc_balance` is always the signer's, so under router funding it does not track
  acquisitions. It still moves when an inventory-funded liquidation engine spends the signer's
  WBTC, or a flash-funded one sweeps profit there.
- Router: alert on `arbitrageur_funding_wbtc_allowance` too.
- The funding gauges refresh only on a cycle that found escrowed vaults, so they go stale during
  quiet periods. Watch the treasury on chain as well, not only through these gauges.
- MANUAL: watch `operator-cli list` and the notifier.

## 7. Starting the Service

### 7.1. Native

The indexer and the bot are long-running foreground processes. Start each in its own terminal or
under a supervisor.

```bash
pnpm arbitrageur:db:up                   # terminal 1, exits when the container is up

pnpm arbitrageur:indexer:start           # terminal 2. `:indexer` runs `ponder dev` instead
curl -f http://localhost:42070/ready     # 503 during backfill, 200 when caught up

pnpm arbitrageur:run                     # terminal 3, once the indexer answers 200
curl http://localhost:9091/health
```

Both indexer scripts read `services/ponder/.env.local`. Variables already exported in the shell
take precedence over that file.

### 7.2. Docker

```bash
docker compose up -d arbitrageur-postgres arbitrageur-ponder arbitrageur-bot
docker compose logs -f arbitrageur-bot
```

Each service starts after the previous one is healthy. `restart: unless-stopped` restarts a
container that exits. A running container that reports unhealthy is not restarted.

Compose does not publish the kill-switch port. Reach it from inside the container, or bind
`RISK_CONTROL_HOST=0.0.0.0` and publish the port yourself.

## 8. Operations

### 8.1. Health

Same endpoints and semantics as the liquidator, on port 9091. See
[liquidator guide §8.1](./liquidator-operation-guide.md#81-health).

### 8.2. Metrics

`GET http://localhost:9091/metrics`. Every metric and error label is defined in
[arbitrageur-metrics.md](arbitrageur-metrics.md). With the liquidation engine on, the
`liquidator_*` set is served from the same endpoint.

```yaml
- alert: ArbitrageurNotPolling
  expr: time() - arbitrageur_last_poll_timestamp > 120
  for: 2m
- alert: ArbitrageurLowFundingWbtc
  expr: arbitrageur_funding_wbtc_balance < 10000000   # 0.1 WBTC in sats
- alert: ArbitrageurLowAllowance
  expr: arbitrageur_funding_wbtc_allowance < 10000000  # router funding only
```

### 8.3. Kill switch

Same server and endpoints as the liquidator. See
[liquidator guide §8.4](./liquidator-operation-guide.md#84-kill-switch). One halt stops both
engines.

A code-hash halt withdraws the allowances this signer granted: the LLP's WBTC allowance under
inventory funding, and the adapter's allowances when the liquidation engine is on. Router funding
withdraws nothing, because that allowance belongs to the treasury, not to this process.

### 8.4. Indexer endpoints

```bash
curl http://localhost:42070/escrowed-vaults      # escrowed vaults with a live preview
curl http://localhost:42070/escrowed-vaults-raw  # indexed rows only, for debugging
```

### 8.5. Restarting under router funding

Skip this under `ARBITRAGE_FUNDING=inventory`.

The bot keeps its signed batches in memory only, so a restart forgets them. The router relays a
batch only for its own signer, and the bot signs a fresh batch for every attempt, so a forgotten
batch is executable by nobody else.

A `relay` transaction that was already broadcast can outlive the process. It may still mine up to
its `ARBITRAGE_RELAY_DEADLINE_SECONDS` deadline. Inside that window:

- The restarted bot publishes the treasury's raw capacity, because it does not know the old batch
  exists. It can commit the same WBTC to a new vault.
- If the old transaction lands first, it is a valid acquisition: the vault reaches your keeper and
  the treasury pays the previewed cost.
- The new acquisition then reverts on the WBTC pull, with its vault still in escrow. That costs gas
  and counts as a genuine failure. If you set `RISK_MAX_CONSECUTIVE_FAILURES`, keep it above
  `RISK_MAX_IN_FLIGHT` so one restart window cannot halt the bot.
- The old acquisition never reaches this process's `arbitrageur_vaults_acquired_total`. Alert on
  the router's `SwapWbtcToVault` events, which record what the treasury paid for.

The next `refreshInventory` reads the real balance, so the accounting corrects itself on the
following cycle.

**Planned stop.** Halt the gate (`POST /halt`), wait until `inFlight` in `GET /status` is zero (or
one poll interval plus `TX_RECEIPT_TIMEOUT_MS`), then stop the process. No transaction is left
outstanding.

**Unplanned stop.** Expect the window above for at most `ARBITRAGE_RELAY_DEADLINE_SECONDS` plus a
block or two. If the gate halted during it, read `GET /status`, confirm that the treasury balance
and the router's recent events explain the failures, and resume.

## 9. Vault Acquisition

`BTCVaultSwap.previewEscrowedVaults(bytes32[])` returns, per vault:

| Field | Meaning |
|---|---|
| `amountVault` | BTC in the vault (sats) |
| `amountDebt` | Current Hub debt: principal plus accrued interest |
| `amountInterest` | Interest accrued since escrow |
| `amountWbtcEquivalent` | Oracle value of the vault in WBTC |
| `amountFee` | Protocol commission on `amountWbtcEquivalent - amountDebt`. Zero when that is not positive |
| `amountWbtcToAcquire` | What the arbitrageur pays: `amountDebt + amountFee` |
| `amountProfitEst` | `max(0, amountWbtcEquivalent - amountWbtcToAcquire)` |

The indexer serves `currentDebt` (`amountWbtcToAcquire`) and `isProfitable`
(`amountProfitEst > 0`). The bot re-reads the preview before each acquisition and authorizes
`maxWbtcIn = amountWbtcToAcquire + amountWbtcToAcquire * MAX_SLIPPAGE_BPS / 10000`. A vault whose
`amountProfitEst` is zero is skipped. Debt accrues while a vault sits in escrow, so the discount
shrinks over time.

Acquisition is first-come-first-served. The first successful transaction wins the vault.

## 10. Incident: signing key compromised

Applies to router funding. The router pulls only the preview cost and refunds the residue to the
treasury, but `vaultSwap` is an argument to each signed call: whoever holds the key can point the
router at a contract of their choosing and spend the entire allowance into it, including to an
address they control.

1. **Revoke the approval first.** Do this before stopping the bot; a stopped bot does not stop
   the attacker. Signed batches stay valid until their deadline, and the router relays them for
   the compromised signer, so only a zero allowance makes them fail.

   ```bash
   cast send "$WBTC_ADDRESS" "approve(address,uint256)" "$ROUTER" 0 \
     --rpc-url "$RPC_URL" --private-key "$TREASURY_KEY"
   ```

2. Halt the bot (`POST /halt`) or stop the process.
3. Deploy a new router for the new signer (§4.4). There is no rotation.
4. Approve the new router from the treasury, with working capital.
5. Configure the new key (`SIGNER_KEY_REF` or `KMS_KEY_ID`, and `SIGNER_ADDRESS`), point
   `ARBITRAGE_ROUTER_ADDRESS` at the new router, and set a new `PERSISTENCE_SCHEMA`. A schema is
   bound to the execution address that first used it.
6. Restart. Boot re-reads the router's immutables and the allowance, and refuses on mismatch.

If the liquidation engine runs with flash funding, treat `LIQUIDATION_ROUTER_ADDRESS` as
compromised too. Its `owner` is this signer, and it sweeps proceeds there.

## 11. Troubleshooting

| Symptom | Cause | Action |
|---------|-------|--------|
| `Configuration validation failed` | Bad or missing env var in the bot | The log names the field |
| `Database schema required` from the indexer | `DATABASE_SCHEMA` unset | Set it in `.env.arbitrageur.indexer` |
| `ARBITRAGE_FUNDING=router requires ...` or `... is set but ARBITRAGE_FUNDING is "inventory"` | Half-configured funding | Set `ARBITRAGE_FUNDING=router` with `ARBITRAGE_ROUTER_ADDRESS` and `VAULT_KEEPER_ADDRESS`, or none |
| `payer ... has not approved ArbitrageRouter` | Missing treasury allowance | The treasury approves the router (§4.4) |
| `EXECUTION_MODE=MANUAL requires DATABASE_URL` | Proposals need a store | Set `DATABASE_URL` |
| `EXECUTION_MODE=MANUAL is keyless` | A signer variable or the key env var is present | Unset it |
| `Indexer ... was not ready within ...` | Backfill longer than `INDEXER_READY_TIMEOUT_MS` | Wait, or raise it |
| `halted (...)` in logs | Risk gate HALTED | `GET /status`, read `reason`, then `POST /resume` |
| `vault_skipped` | Vault left escrow, or previewed profit is zero | Normal |
| `race_lost` | Another arbitrageur took the vault | Normal competition |
| `swap_reverted` | Reverted with the vault still in escrow | Inspect the revert. Counts toward the breaker |
| `authorization_expired` | Signed batch sat behind a stalled nonce past `ARBITRAGE_RELAY_DEADLINE_SECONDS` | Look at nonce gaps, not the market |
| `tx_timeout` | No receipt within `TX_RECEIPT_TIMEOUT_MS` | Check the network, or raise it |
| `EADDRINUSE` on 9095 | Both services on one host with the kill switch on | Set a distinct `RISK_CONTROL_PORT` |

Logs go to stdout. Under Docker: `docker compose logs -f arbitrageur-bot --tail 100`.
