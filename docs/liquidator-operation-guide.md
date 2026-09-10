# Liquidator Operation Guide

Operation of the liquidation service for the Aave v4 integration with Babylon's Trustless
Bitcoin Vaults protocol.

> This is a reference implementation. Liquidations are first-come-first-served and competitive.
> Operators who want to win more of them need their own gas strategy and submission policy.

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Requirements](#2-system-requirements)
3. [Architecture Overview](#3-architecture-overview)
4. [Installation](#4-installation)
5. [Configuration](#5-configuration)
6. [Wallet Setup](#6-wallet-setup)
7. [Starting the Service](#7-starting-the-service)
8. [Operations](#8-operations)
9. [Troubleshooting](#9-troubleshooting)

## 1. Introduction

The service monitors positions on the Babylon Core Spoke that are backed by native Bitcoin
collateral, and liquidates them when their health factor drops below 1.0.

| Component | Description |
|-----------|-------------|
| **Ponder Indexer** | Indexes `Supply`, `Withdraw`, `LiquidationCall` and `UserProxyCreated` events, tracks positions, and serves `/liquidatable-positions` |
| **Liquidation Client** | Polls the indexer, estimates inputs through the Lens, and executes liquidations |

## 2. System Requirements

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| Ponder Indexer | 2 vCPUs | 4 GB | 20 GB SSD |
| Liquidation Client | 1 vCPU | 1 GB | 10 GB SSD |
| PostgreSQL | 2 vCPUs | 4 GB | 50 GB SSD |

External services: an Ethereum RPC endpoint (indexing and execution) and PostgreSQL 17.

| Port | Purpose |
|------|---------|
| 42069 | Ponder indexer API |
| 9090 | Metrics, health, and readiness |
| 9095 | Kill switch (optional, loopback by default) |
| 5432 | PostgreSQL |

## 3. Architecture Overview

```
Ethereum RPC ──┬──▶ Ponder Indexer ──▶ /liquidatable-positions
               │         │
               │         ▼
               └──▶ Liquidation Client
                     - AUTO: signs and broadcasts
                     - MANUAL: writes proposals for operator-cli
                     - calls AaveAdapter.liquidate() or liquidateWithLLP()
                     - serves /metrics, /health, /ready
                          │
                          ▼
                    AaveAdapter ──▶ Babylon Core Spoke
                     - direct mode: redeems the seized vault to a BTC key
                     - LLP mode: escrows it in BTCVaultSwap for an arbitrageur
```

## 4. Installation

### 4.1. Prerequisites

- Node.js 20 or 22 (the Docker images use 22)
- pnpm 9.13.2
- PostgreSQL 17
- Foundry, only to deploy the router (flash funding)

### 4.2. Native Installation

```bash
git clone https://github.com/babylonlabs-io/aave-v4-bots.git
cd aave-v4-bots
pnpm install
```

Key paths:

```
services/liquidator/     # bot composition root
services/operator-cli/   # MANUAL-mode operator tool
services/ponder/         # indexer (shared with the arbitrageur)
contracts/               # LiquidationRouter and swap venues
.env.liquidator          # bot configuration
.env.liquidator.indexer  # indexer configuration
docker-compose.yml
```

### 4.3. Docker Installation

Compose builds the images from `docker/*.Dockerfile`:

```bash
docker compose build liquidator-ponder liquidator-bot
```

`build` needs no configuration. `docker compose up` reads `.env.liquidator` and
`.env.liquidator.indexer` and fails if either is missing, so create them first (§5.1).

### 4.4. Router contract (flash funding only)

Skip this under `LIQUIDATION_FUNDING=inventory`.

Flash funding repays each debt token through a `LiquidationRouter`. Deploy it once:

```bash
git submodule update --init --recursive

export LIQUIDATION_ROUTER_OWNER=0x...   # this bot's signer: the only address the router acts for
export LENS_ADDRESS=0x...               # AaveAdapterLiquidationPreview
export VAULT_SWAP_ADDRESS=0x...         # BTCVaultSwap (LLP)
export DEPLOYER_PRIVATE_KEY=0x...
export RPC_URL=https://...

forge script scripts/DeployLiquidationRouter.s.sol:DeployLiquidationRouter \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

The script prints the router address. Export it, then deploy one `UniswapV4SwapVenue` bound to it:

```bash
export ROUTER=0x...                      # the LiquidationRouter the script printed
export UNISWAP_V4_POOL_MANAGER=0x...     # the PoolManager on this chain

forge create contracts/WrappedVenue/UniswapV4SwapVenue.sol:UniswapV4SwapVenue \
  --constructor-args "$UNISWAP_V4_POOL_MANAGER" "$ROUTER" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
```

Put the two printed addresses in `LIQUIDATION_ROUTER_ADDRESS` and `FLASH_SWAP_VENUE_ADDRESS`. All
constructor arguments are immutable. A router deployed for another signer must be redeployed.

The bot does not verify `owner` at boot. A wrong owner shows as every flash probe reverting.

The router always calls `liquidateWithLLP` on the `vaultSwap` it was deployed with. Under flash
funding keep `IS_DIRECT_REDEMPTION=false`, so the Lens estimate matches that path;
`BTC_REDEEM_KEY` and `LLP_ADDRESS` are unused.

## 5. Configuration

### 5.1. Environment Files

| File | Used by |
|------|---------|
| `.env.liquidator` | The bot. Holds the key, risk and submission settings |
| `.env.liquidator.indexer` | The indexer. Holds indexing settings only, and no secrets |

```bash
cp env.liquidator.example         .env.liquidator
cp env.liquidator.indexer.example .env.liquidator.indexer

# Native only. Ponder reads .env.local from its own directory. Docker reads the root file directly.
cp .env.liquidator.indexer services/ponder/.env.local
```

Keep `ADAPTER_ADDRESS`, `LENS_ADDRESS` and the database in step between the two files.

### 5.2. Ponder Indexer Configuration

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `PONDER_RPC_URL` | RPC for indexing. May differ from the bot's | Yes | |
| `SPOKE_ADDRESS` | Babylon Core Spoke | Yes | |
| `ADAPTER_ADDRESS` | AaveAdapter | Yes | |
| `LENS_ADDRESS` | AaveAdapterLiquidationPreview. The API previews positions through it | Yes | |
| `DATABASE_URL` | PostgreSQL connection string. Ponder falls back to an embedded PGlite database when it is unset, which these guides do not use | Yes | |
| `DATABASE_SCHEMA` | Schema for Ponder's tables. `ponder start` requires it | Yes | |
| `CHAIN_ID` | Network chain ID | No | `1` |
| `START_BLOCK` | First block to index | No | `0` |
| `PONDER_POLLING_INTERVAL` | Block poll interval (ms) | No | `4000` |
| `PONDER_PORT` | API port. The `liquidator:indexer*` scripts and Compose both set it themselves, so a value here only applies when you run Ponder directly. Compose publishes the host port as `LIQUIDATOR_PONDER_PORT` | No | `42069` |
| `POSITION_PROBE_CHUNK_SIZE` | Positions per batched `eth_call` in `/liquidatable-positions`. A batch over the node's gas cap fails whole and reports its positions as `unscanned`. Raise only against a known cap | No | `25` |
| `MULTICALL3_ADDRESS` | Multicall3 for the API's batched reads. Falls back to single reads when absent on chain | No | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| `CONFIG_SECRET_ID` | AWS Secrets Manager id holding `PONDER_RPC_URL` and `DATABASE_URL` as JSON, for values not set in the env | No | |

### 5.3. Liquidation Client Configuration

Minimal `.env.liquidator`:

```bash
PONDER_URL=http://localhost:42069
CLIENT_RPC_URL=https://...
ADAPTER_ADDRESS=0x...
LENS_ADDRESS=0x...
WBTC_ADDRESS=0x...
LLP_ADDRESS=0x...
LIQUIDATOR_PRIVATE_KEY=0x...
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
```

Everything else has a default, listed in the tables below. Under Docker, `PONDER_URL` and
`METRICS_PORT` are set by Compose, and `DATABASE_URL` must point at `liquidator-postgres:5432`,
not `localhost`.

**Core**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `PONDER_URL` | Indexer API endpoint | Yes | |
| `CLIENT_RPC_URL` | RPC for execution | Yes | |
| `ADAPTER_ADDRESS` | AaveAdapter | Yes | |
| `LENS_ADDRESS` | AaveAdapterLiquidationPreview | Yes | |
| `WBTC_ADDRESS` | WBTC token | Yes | |
| `POLLING_INTERVAL_MS` | Poll interval | No | `12000` |
| `TX_RECEIPT_TIMEOUT_MS` | Receipt wait per transaction | No | `120000` |
| `RETRY_MAX_ATTEMPTS` | Attempts per read, indexer and RPC | No | `3` |
| `RETRY_INITIAL_DELAY_MS` | First retry delay | No | `1000` |
| `RETRY_MAX_DELAY_MS` | Retry delay ceiling. Bounds indexer reads only; viem runs its own RPC schedule | No | `5000` |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` | No | `info` |
| `METRICS_PORT` | Metrics and health server port | No | `9090` |
| `METRICS_HOST` | Interface the metrics server binds. `/metrics` is unauthenticated and carries the signer address and balances, so bind it to the scraper's interface where no network policy applies | No | all interfaces |

**Funding and redemption**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `LIQUIDATION_FUNDING` | `inventory` repays from the signer's balances. `flash` repays through `LiquidationRouter`. The mode is never inferred: flash variables without `flash`, or `flash` without all four, fail at boot | No | `inventory` |
| `LIQUIDATION_ROUTER_ADDRESS` | LiquidationRouter. Its `owner` must be this signer | flash | |
| `FLASH_SWAP_VENUE_ADDRESS` | The `UniswapV4SwapVenue` bound to that router. One venue serves every pool | flash | |
| `FLASH_SWAP_POOLS` | One `token:currency0:currency1:fee:tickSpacing[:hooks]` per debt token, comma-separated. Each pool must be WBTC/`<token>`; currencies in Uniswap order | flash | |
| `WBTC_FLASH_LOAN_ADDRESS` | Venue WBTC is flash-loaned from for the LLP fairness payment | flash | |
| `WBTC_FLASH_LOAN_VENUE` | `morpho` or `aavev3` | No | `morpho` |
| `FLASH_MAX_SLIPPAGE_BPS` | How far realised profit may fall below the probe's quote before the transaction reverts. Enforced on-chain; the only slippage bound in flash mode. `10000` removes it | No | `2000` |
| `IS_DIRECT_REDEMPTION` | `true` calls `liquidate` and redeems to `BTC_REDEEM_KEY`; `false` calls `liquidateWithLLP`. Also selects the Lens estimate, so keep `false` under flash | No | `false` |
| `BTC_REDEEM_KEY` | Inventory, direct mode. Must be non-zero | direct | |
| `LLP_ADDRESS` | Inventory, LLP mode. BTCVaultSwap. Must be non-zero | LLP | |

**Signer, secrets and execution mode**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `EXECUTION_MODE` | `AUTO` signs and broadcasts. `MANUAL` is keyless and writes proposals | No | `AUTO` |
| `SECRETS_PROVIDER` | Where secret references resolve: `env` (another env var) or `aws` (Secrets Manager id, optionally `name#jsonKey`) | No | `env` |
| `SIGNER_SOURCE` | `local` key or `aws` KMS | No | `local` |
| `LIQUIDATOR_PRIVATE_KEY` | Default local key | AUTO, local | |
| `SIGNER_KEY_REF` | Secret reference for the local key | No | `LIQUIDATOR_PRIVATE_KEY` |
| `KMS_KEY_ID` | KMS key id, ARN or alias. Key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`. IAM needs `kms:GetPublicKey` and `kms:Sign` | KMS | |
| `SIGNER_ADDRESS` | Expected signer address. Boot fails if the key derives another. Set it whenever the key is behind a ref or KMS id | No | |
| `AWS_REGION` | Region for KMS and Secrets Manager. Falls back to the AWS SDK's own resolution (environment or profile) when unset | No | |
| `MANUAL_EXECUTOR_ADDRESS` | Account the operator executes from. The Safe itself in `safe` custody | MANUAL | |
| `MANUAL_EXECUTOR_KIND` | `eoa` or `safe`. No default | MANUAL | |
| `MANUAL_INTENT_TTL_MS` | Expire un-actioned proposals after this. `0` disables | No | `10800000` |
| `MANUAL_INTENT_STUCK_MS` | Alert on `claimed` or `submitted` intents older than this. `0` disables | No | `3600000` |
| `DATABASE_URL` | Enables the Postgres StateStore: intent idempotency, nonce lease, reconcile on boot | MANUAL, private submission | |
| `PERSISTENCE_SCHEMA` | Schema for the StateStore. One schema per signer: the first execution identity to use it claims it. Two services on one database need two values | No | `bot` |
| `NOTIFIER` | `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for the webhook URL | slack | |

Run one AUTO process per signer. Nonce allocation is per process, and two processes on one key
overrun each other.

**Indexer liveness**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `INDEXER_MAX_LAG_BLOCKS` | Skip the cycle when the indexer is more than this many blocks behind the chain. Unset disables the guard | No | |
| `INDEXER_MAX_LAG_HALT_MS` | Halt the risk gate when the indexer stays unusable for this long | No | `60000` |
| `INDEXER_READY_TIMEOUT_MS` | Wait this long at boot for the indexer's `/ready`, then fail. Unset starts at once | No | |

**Risk gate**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `RISK_MAX_CONSECUTIVE_FAILURES` | Halt after this many consecutive failed actions | No | |
| `RISK_MIN_PROFIT` | Profit floor in sats, checked off-chain before sending and carried into the router call's `minWbtcProfit` when it binds harder than `FLASH_MAX_SLIPPAGE_BPS`. Allowed under `flash`, which probes the router for an expected profit. Rejected at boot under `inventory`, which has none | No | |
| `RISK_MAX_IN_FLIGHT` | Cap on actions in flight. Bounds one cycle's burst. Size above the largest cascade you want to compete in | No | unlimited |
| `RISK_MAX_DATA_STALENESS_MS` | Reject indexer data older than this, missing a timestamp, or more than 30 s in the future | No | |
| `RISK_START_HALTED` | Boot HALTED until `POST /resume`. Requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | `address=keccak256(bytecode),...`. A mismatch halts the bot | No | |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference for the kill-switch bearer token. Set it to start the kill-switch server | No | |
| `RISK_CONTROL_PORT` | Kill-switch port. Both services default to the same value; set it when they share a host | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host | No | `127.0.0.1` |

### 5.4. Execution Modes

`AUTO` resolves a signer from `SIGNER_SOURCE`, signs approvals and liquidations, and waits for
receipts. Under `flash` there are no approvals: the bot never moves its own tokens.

`MANUAL` is keyless. It requires `DATABASE_URL`, `MANUAL_EXECUTOR_ADDRESS` and
`MANUAL_EXECUTOR_KIND`. It refuses to boot with `SIGNER_SOURCE=aws`, `SIGNER_KEY_REF`,
`KMS_KEY_ID`, `SIGNER_ADDRESS`, or a populated signing-key env var. Instead of broadcasting, it
writes a content-hashed proposal to the StateStore and notifies. The operator acts on proposals
with `operator-cli`, see §8.3.

### 5.5. Private submission

Same variables and behaviour as the arbitrageur. Read
[§5.5 of the arbitrageur guide](arbitrageur-operation-guide.md#55-private-submission) before
enabling it. Liquidation is the more contested path, so the reach-versus-protection trade-off
matters more here.

### 5.6. Contract Addresses

Testnet addresses are provided during onboarding.

| Variable | Contract |
|----------|----------|
| `SPOKE_ADDRESS` | Core Spoke. Source of the position set (indexer only) |
| `ADAPTER_ADDRESS` | AaveAdapter. Entry point for `liquidate` and `liquidateWithLLP` |
| `LENS_ADDRESS` | AaveAdapterLiquidationPreview. `estimateLiquidation` |
| `WBTC_ADDRESS` | WBTC token |
| `LLP_ADDRESS` | BTCVaultSwap, for LLP-mode redemption under inventory funding |

## 6. Wallet Setup

**`inventory`**

| Asset | Purpose |
|-------|---------|
| ETH | Gas |
| Debt tokens | Repay borrower debt. A position larger than the balance is skipped |
| WBTC | LLP fairness payment, and the redemption fee in direct mode |

**`flash`**

| Asset | Purpose |
|-------|---------|
| ETH | Gas. The only balance the bot needs |

Under `flash`, profit is swept to the signer as WBTC. Each `FLASH_SWAP_POOLS` entry needs enough
depth for a liquidation-sized swap. A thin pool does not fail loudly: the probe quotes an
unprofitable result and the bot declines, which looks like the bot doing nothing.

Monitoring:

- ETH: the bot does not export its ETH balance. Use an external balance monitor.
- `inventory`: alert on `liquidator_token_balance` for each debt token and WBTC.
- `flash`: debt-token balances are not capacity. Alert on `liquidator_liquidations_failed_total`.
- MANUAL: watch `operator-cli list` and the notifier.

## 7. Starting the Service

### 7.1. Native

The indexer and the bot are long-running foreground processes. Start each in its own terminal or
under a supervisor.

```bash
pnpm liquidator:db:up                    # terminal 1, exits when the container is up

pnpm liquidator:indexer:start            # terminal 2. `:indexer` runs `ponder dev` instead
curl -f http://localhost:42069/ready     # 503 during backfill, 200 when caught up

pnpm liquidator:run                      # terminal 3, once the indexer answers 200
curl http://localhost:9090/health
```

Both indexer scripts read `services/ponder/.env.local`. Variables already exported in the shell
take precedence over that file, so two native indexers on one host each need their own exported
set, or one shared indexer with every address set (see the Ponder README).

### 7.2. Docker

```bash
docker compose up -d liquidator-postgres liquidator-ponder liquidator-bot
docker compose logs -f liquidator-bot
```

Each service starts after the previous one is healthy. `restart: unless-stopped` restarts a
container that exits. A running container that reports unhealthy is not restarted.

Compose does not publish the kill-switch port. Reach it from inside the container, or bind
`RISK_CONTROL_HOST=0.0.0.0` and publish the port yourself.

## 8. Operations

### 8.1. Health

| Endpoint | Response |
|----------|----------|
| `GET /health` | `{status, uptime, lastPollAt, ponderReachable, rpcReachable, latestBlockNumber}`. `healthy` when the indexer's `/ready` and the RPC both answer, `degraded` (200) when one does, `unhealthy` (503) when neither does |
| `GET /ready` | 200 only when both answer, else 503 |

These endpoints say nothing about polling or trading. Alert on `liquidator_last_poll_timestamp`
and the kill-switch `/status` for that.

### 8.2. Metrics

`GET http://localhost:9090/metrics`. Every metric and error label is defined in
[liquidator-metrics.md](liquidator-metrics.md).

```yaml
- alert: LiquidatorNotPolling
  expr: time() - liquidator_last_poll_timestamp > 60
  for: 2m
- alert: LiquidatorFailing
  expr: increase(liquidator_liquidations_failed_total[15m]) > 0
```

### 8.3. MANUAL proposals

The CLI reads `.env` from `services/operator-cli/`, not the bot's file. It needs `CLIENT_RPC_URL`,
`DATABASE_URL`, `PERSISTENCE_SCHEMA`, `MANUAL_EXECUTOR_ADDRESS` and `MANUAL_EXECUTOR_KIND`, matching
the bot. `broadcast` also needs `OPERATOR_KEY_REF` (eoa) or `SAFE_OWNER_KEY_REFS` (safe). The
other commands are keyless.

```bash
CLI="pnpm --filter @services/operator-cli start"
$CLI list                        # all proposals. Inventory mode emits `approval` ones first
$CLI show <id>
$CLI claim <id>                  # safe custody: prints the safeTxHash to sign externally
$CLI confirm <id> --tx <hash>    # record an externally signed transaction
$CLI broadcast <id>              # sign and send with the configured operator key
$CLI release <id>                # undo a claim. Check the chain first: see the CLI README
$CLI fail <id> --reason <r>      # give up on an intent
```

### 8.4. Kill switch

Served on `RISK_CONTROL_HOST:RISK_CONTROL_PORT` when `RISK_CONTROL_TOKEN_REF` is set. Never on
the metrics port.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9095/status
curl -XPOST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9095/halt?reason=incident"
curl -XPOST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9095/resume
```

`GET /status` returns `{state, inFlight, reason, codeVerified}`. Read `reason` before resuming:
a halt raised while already HALTED sends no alert, so this is its only record. `codeVerified`
is `true` once every pinned address has passed a check in this process.

`POST /resume` clears the kill switch only. It answers 409 while the code-hash guard holds the
halt. That clears itself on the next successful check. If the pinned hash is wrong, correct
`RISK_EXPECTED_CODE_HASHES` and restart.

### 8.5. Indexer endpoints

```bash
curl http://localhost:42069/positions               # every position in the table
curl http://localhost:42069/liquidatable-positions  # positions the Lens can liquidate, with reserve ids and amounts
```

In `/liquidatable-positions`, `checked` counts positions with an answer and `unscanned` those
without: a batch that failed whole, or a probe that reverted for a reason other than the
position being healthy. A nonzero `unscanned` means the list is incomplete for that request. The
indexer logs the revert reasons once per cycle.

## 9. Troubleshooting

| Symptom | Cause | Action |
|---------|-------|--------|
| `Configuration validation failed` | Bad or missing env var in the bot | The log names the field |
| `Database schema required` from the indexer | `DATABASE_SCHEMA` unset | Set it in `.env.liquidator.indexer` |
| `LIQUIDATION_FUNDING=flash requires ...` or `... is set but LIQUIDATION_FUNDING is "inventory"` | Half-configured funding | Set all four flash variables, or none |
| `EXECUTION_MODE=MANUAL requires DATABASE_URL` | Proposals need a store | Set `DATABASE_URL` |
| `EXECUTION_MODE=MANUAL is keyless` | A signer variable or the key env var is present | Unset it |
| `RISK_MIN_PROFIT is set but this process runs an inventory-funded liquidation engine` | Inventory funding cannot price actions | Unset it, or use flash |
| `Indexer ... was not ready within ...` | Backfill longer than `INDEXER_READY_TIMEOUT_MS` | Wait, or raise it |
| `halted (...)` in logs | Risk gate HALTED | `GET /status`, read `reason`, then `POST /resume` (409 means the code-hash guard holds it) |
| `liquidator_errors_total{type="positions_unscanned"}` | Probe batch failed, or probes reverted for a reason other than healthy | Read the indexer log. An oracle at zero or a wrong `LENS_ADDRESS` reverts every probe. Lower `POSITION_PROBE_CHUNK_SIZE` against a gas cap |
| `tx_reverted` | Reverted with the position still open | Inspect the revert. Counts toward the breaker |
| `race_lost` | Another liquidator took the position | Normal competition |
| Every flash probe reverts | Router `owner` is not this signer, or a pool is not WBTC/`<token>` | Check the router and `FLASH_SWAP_POOLS` |
| Bot does nothing under flash | Probes quote a profit of zero or less, so the candidate is skipped before any slippage bound applies | Check pool depth and the debt tokens in `FLASH_SWAP_POOLS`. Raising `FLASH_MAX_SLIPPAGE_BPS` does not help here |
| `EADDRINUSE` on 9095 | Both services on one host with the kill switch on | Set a distinct `RISK_CONTROL_PORT` |

Logs go to stdout. Under Docker: `docker compose logs -f liquidator-bot --tail 100`.
