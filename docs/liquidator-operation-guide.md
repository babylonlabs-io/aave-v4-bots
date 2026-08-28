# Liquidator Operation Guide

This guide covers operation of the liquidation service for the Aave v4 integration
with Babylon's Trustless Bitcoin Vaults protocol.

> **Note**: This is a reference implementation designed for simplicity and reliability.
> Liquidations are first-come-first-served and competitive in production environments.
> Operators seeking to maximize liquidation success may need to implement additional
> optimizations (gas strategies, private mempools, etc.).

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Requirements](#2-system-requirements)
   - [Hardware Specifications](#21-hardware-specifications)
   - [External Service Connections](#22-external-service-connections)
   - [Network Requirements](#23-network-requirements)
3. [Architecture Overview](#3-architecture-overview)
4. [Installation](#4-installation)
   - [Prerequisites](#41-prerequisites)
   - [Native Installation](#42-native-installation)
   - [Docker Installation](#43-docker-installation)
   - [Router contract (flash funding only)](#44-router-contract-flash-funding-only)
5. [Configuration](#5-configuration)
   - [Environment Files](#51-environment-files)
   - [Ponder Indexer Configuration](#52-ponder-indexer-configuration)
   - [Liquidation Client Configuration](#53-liquidation-client-configuration)
   - [Execution Modes](#54-execution-modes)
   - [Contract Addresses](#55-contract-addresses)
6. [Wallet Setup](#6-wallet-setup)
   - [Funding Requirements](#61-funding-requirements)
7. [Starting the Service](#7-starting-the-service)
   - [Native Deployment](#71-native-deployment)
   - [Docker Deployment](#72-docker-deployment)
8. [Operations](#8-operations)
   - [Health Monitoring](#81-health-monitoring)
   - [Prometheus Metrics](#82-prometheus-metrics)
   - [Manual Commands](#83-manual-commands)
9. [Troubleshooting](#9-troubleshooting)
   - [Common Issues](#91-common-issues)
   - [Error Types](#92-error-types)

## 1. Introduction

The liquidation service monitors positions on the Aave v4 Babylon Core Spoke backed by
native Bitcoin collateral and executes liquidations when positions become
undercollateralized (health factor < 1.0).

The service consists of two components:

| Component | Description |
|-----------|-------------|
| **Ponder Indexer** | Indexes blockchain events (`Supply`, `Withdraw`, `LiquidationCall`, `UserProxyCreated`) and tracks all active positions with collateral |
| **Liquidation Client** | Polls the indexer for liquidatable positions and executes liquidation transactions |

## 2. System Requirements

### 2.1. Hardware Specifications

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| Ponder Indexer | 2 vCPUs | 4 GB | 20 GB SSD |
| Liquidation Client | 1 vCPU | 1 GB | 10 GB SSD |
| PostgreSQL | 2 vCPUs | 4 GB | 50 GB SSD |

> **Note**: These are recommended minimum values. Adjust based on your workload and monitoring observations.

### 2.2. External Service Connections

| Service | Purpose | Default Endpoint |
|---------|---------|------------------|
| Ethereum RPC | Event indexing, transaction execution | Configurable |
| PostgreSQL | Ponder indexer data storage and optional bot StateStore | `localhost:5432` |

### 2.3. Network Requirements

**Ports:**

| Port | Protocol | Purpose |
|------|----------|---------|
| 42069 | HTTP | Ponder indexer API |
| 9090 | HTTP | Metrics, health, and readiness endpoints |
| 9095 | HTTP | Optional risk-control kill switch, loopback by default |
| 5432 | TCP | PostgreSQL database |

## 3. Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Ethereum RPC  │     │   PostgreSQL    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│           Ponder Indexer                │
│  - Indexes Supply/Withdraw/Liquidation  │
│  - Tracks active positions              │
│  - Exposes /liquidatable-positions API  │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│         Liquidation Client              │
│  - Polls indexer at configured interval │
│  - Estimates inputs via Lens contract   │
│  - Simulates liquidations               │
│  - AUTO: signs and broadcasts           │
│  - MANUAL: persists proposals for       │
│    operator-cli                         │
│  - Calls liquidate() or                 │
│    liquidateWithLLP() on AaveAdapter    │
│  - Exposes /metrics, /health, /ready    │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│            AaveAdapterLens              │
│  - Pre-computes liquidation amounts     │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│              AaveAdapter                │
│  - Direct mode: redeems vault to BTC    │
│    key in same tx                       │
│  - LLP mode: escrows vault in           │
│    BTCVaultSwap for arbitrageur         │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│         Babylon Core Spoke              │
│  - Manages positions and collateral     │
└─────────────────────────────────────────┘
```

## 4. Installation

### 4.1. Prerequisites

- **Node.js**: >= 18.14
- **pnpm**: 9.13.2+
- **PostgreSQL**: 17+

### 4.2. Native Installation

**Clone and install dependencies:**

```bash
git clone https://github.com/babylonlabs-io/aave-v4-bots.git
cd aave-v4-bots
pnpm install
```

**Directory structure:**

```
aave-v4-bots/
├── services/
│   ├── liquidator/          # Liquidation bot composition root
│   ├── operator-cli/        # MANUAL-mode operator workflow
│   └── ponder/              # Unified blockchain indexer
├── packages/                # @repo/* packages by concern
├── .env.liquidator          # Client configuration
└── docker-compose.yml       # Docker orchestration
```

### 4.3. Docker Installation

Pre-built images are available from Docker Hub:

| Image | Description |
|-------|-------------|
| `babylonlabs/liquidation-aave-indexer` | Ponder indexer |
| `babylonlabs/liquidation-aave-bot` | Liquidation client |

Docker Compose will automatically pull these images. To build locally instead:

```bash
docker compose build liquidator-ponder liquidator-bot
```

### 4.4. Router contract (flash funding only)

Skip this under `LIQUIDATION_FUNDING=inventory` — the bot repays from its own balances and needs no
contract of its own.

Flash funding repays each debt token through a `LiquidationRouter`, which you deploy once:

```bash
export LIQUIDATION_ROUTER_OWNER=0x...   # this bot's signer — the only address it will act for
export LENS_ADDRESS=0x...               # AaveAdapterLens
export VAULT_SWAP_ADDRESS=0x...         # the BTCVaultSwap (LLP)
export DEPLOYER_PRIVATE_KEY=0x...

forge script scripts/DeployLiquidationRouter.s.sol:DeployLiquidationRouter \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

Put the deployed address in `LIQUIDATION_ROUTER_ADDRESS`. `owner` is immutable and is checked
against the bot's signer at boot, so a router deployed for a different key has to be redeployed
rather than reconfigured.

The router still needs its venues — a `UniswapV4SwapVenue` per debt token plus the WBTC flash-loan
venue for the LLP fairness payment. Those are bot configuration, not deploy arguments: see
`FLASH_SWAP_POOLS` and `WBTC_FLASH_LOAN_ADDRESS` in §5.

## 5. Configuration

### 5.1. Environment Files

The service requires two environment configurations:

| Component | File Location | Purpose |
|-----------|---------------|---------|
| Client | `.env.liquidator` (root) | Liquidation client settings |
| Ponder | `services/ponder/.env.local` | Indexer settings |

**Create configuration files:**

```bash
# Copy template
cp env.liquidator.example         .env.liquidator          # the bot: key, risk, submission
cp env.liquidator.indexer.example .env.liquidator.indexer  # the indexer: indexing variables only

# Create Ponder env (copy relevant vars from .env.liquidator)
cp .env.liquidator services/ponder/.env.local
```

### 5.2. Ponder Indexer Configuration

Configure the indexer in `services/ponder/.env.local`:

```bash
# RPC URL for blockchain indexing
PONDER_RPC_URL=https://eth-mainnet.example.com

# Core Spoke contract address (Babylon's dedicated Spoke)
SPOKE_ADDRESS=0x...

# AaveAdapter address
ADAPTER_ADDRESS=0x...

# Chain ID
CHAIN_ID=1

# Block number to start indexing from
START_BLOCK=20000000

# Blockchain polling interval (milliseconds)
PONDER_POLLING_INTERVAL=4000

# PostgreSQL connection
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
DATABASE_SCHEMA=public
```

| Parameter | Description | Required? | Default |
|-----------|-------------|-----------|---------|
| `PONDER_RPC_URL` | Ethereum RPC endpoint for indexing | Yes | — |
| `SPOKE_ADDRESS` | Babylon's Aave Core Spoke contract | Yes | — |
| `ADAPTER_ADDRESS` | AaveAdapter contract | Yes | — |
| `CHAIN_ID` | Network chain ID | No | `1` |
| `START_BLOCK` | Block to begin indexing | No | `0` |
| `PONDER_POLLING_INTERVAL` | How often to poll for new blocks (ms) | No | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | Yes | — |
| `DATABASE_SCHEMA` | PostgreSQL schema | No | `public` |

### 5.3. Liquidation Client Configuration

Configure the client in `.env.liquidator`:

```bash
# ====== Required ======

# Ponder indexer API URL
PONDER_URL=http://localhost:42069

# RPC URL for transaction execution
CLIENT_RPC_URL=https://eth-mainnet.example.com

# Contract addresses
ADAPTER_ADDRESS=0x...       # AaveAdapter
LENS_ADDRESS=0x...          # AaveAdapterLens
WBTC_ADDRESS=0x...

# ====== Funding mode ======
# inventory (default) repays from this signer's balances; flash repays through LiquidationRouter,
# which borrows each debt token and repays out of the seized collateral in the same tx.
# LIQUIDATION_FUNDING=inventory
# The four below are required together when LIQUIDATION_FUNDING=flash. Enforced both ways: setting
# them WITHOUT the flag is also a boot error, since the mode is never inferred from their presence.
# LIQUIDATION_ROUTER_ADDRESS=0x...   # its immutable owner must be this bot's signer
# FLASH_SWAP_VENUE_ADDRESS=0x...     # the UniswapV4SwapVenue bound to that router
# FLASH_SWAP_POOLS=0xUSDC:0xWBTC:0xUSDC:3000:60   # one WBTC/<token> pool per debt token
# WBTC_FLASH_LOAN_ADDRESS=0x...      # funds the LLP fairness payment
# WBTC_FLASH_LOAN_VENUE=morpho       # morpho | aavev3
# FLASH_MAX_SLIPPAGE_BPS=2000      # how far the result may decay from the quote before reverting

# ====== Optional ======

# Debt token addresses (comma-separated). If unset, auto-discovered from
# the Spoke's borrowable reserves.

# Selects the redemption mode:
#   true  → calls AaveAdapter.liquidate(borrower, BTC_REDEEM_KEY, ...)
#           and redeems the seized vault directly to BTC_REDEEM_KEY
#   false → calls AaveAdapter.liquidateWithLLP(borrower, LLP_ADDRESS, ...)
#           and escrows the seized vault in the LLP for an arbitrageur
# IS_DIRECT_REDEMPTION=false

# Required if IS_DIRECT_REDEMPTION=true. Must be non-zero in direct mode.
# BTC_REDEEM_KEY=0x...

# Required if IS_DIRECT_REDEMPTION=false. The LLP (BTCVaultSwap) address.
# Must be non-zero in LLP mode.
# LLP_ADDRESS=0x...

# Execution mode (default: AUTO). MANUAL is keyless and writes proposals.
EXECUTION_MODE=AUTO
# MANUAL_EXECUTOR_ADDRESS=0x...
# MANUAL_EXECUTOR_KIND=eoa
# MANUAL_INTENT_TTL_MS=10800000
# MANUAL_INTENT_STUCK_MS=3600000

# Signer and secrets (defaults: env-backed local key from LIQUIDATOR_PRIVATE_KEY)
SECRETS_PROVIDER=env
SIGNER_SOURCE=local
LIQUIDATOR_PRIVATE_KEY=0x...
# SIGNER_KEY_REF=LIQUIDATOR_PRIVATE_KEY
# KMS_KEY_ID=arn:aws:kms:...
# SIGNER_ADDRESS=0x...
# AWS_REGION=us-east-1

# Persistence / crash-safety. Required in MANUAL; optional in AUTO.
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
# PERSISTENCE_SCHEMA=bot

# Notifications (default: log-only)
NOTIFIER=none
# SLACK_WEBHOOK_REF=SLACK_WEBHOOK_URL

# Risk gate (unset variables disable their guard)
# RISK_MAX_CONSECUTIVE_FAILURES=5
# RISK_MIN_PROFIT is rejected at boot under LIQUIDATION_FUNDING=inventory (that path supplies no
# expected profit) and allowed under flash, which probes the router for a real one.
# RISK_MIN_PROFIT=1000
# Unset means NO cap. Bounds one poll cycle's burst; the breaker settles on receipts and so cannot
# stop the cycle already in flight. Size above the largest cascade you want to compete in.
# RISK_MAX_IN_FLIGHT=25
# RISK_MAX_DATA_STALENESS_MS=60000
# RISK_START_HALTED=false
# RISK_EXPECTED_CODE_HASHES=0xAdapter...=0xhash...,0xLens...=0xhash...
# RISK_CODE_CHECK_INTERVAL_MS=300000
# RISK_CONTROL_TOKEN_REF=BOT_CONTROL_TOKEN
# RISK_CONTROL_PORT=9095
# RISK_CONTROL_HOST=127.0.0.1

# Position check frequency (default: 12000 ms)
POLLING_INTERVAL_MS=12000

# Receipt wait timeout (default: 120000 ms)
TX_RECEIPT_TIMEOUT_MS=120000

# Metrics server port (default: 9090)
METRICS_PORT=9090
```

| Parameter | Description | Required? | Default |
|-----------|-------------|-----------|---------|
| `LIQUIDATOR_PRIVATE_KEY` | Default local signer key ref target; not used with KMS or MANUAL | AUTO + local | — |
| `PONDER_URL` | Indexer API endpoint | Yes | — |
| `CLIENT_RPC_URL` | RPC for transaction execution | Yes | — |
| `ADAPTER_ADDRESS` | AaveAdapter address | Yes | — |
| `LENS_ADDRESS` | AaveAdapterLens address | Yes | — |
| `WBTC_ADDRESS` | WBTC token address | Yes | — |
| `LIQUIDATION_FUNDING` | `inventory` (repay from own balances) or `flash` (repay via LiquidationRouter) | No | `inventory` |
| `LIQUIDATION_ROUTER_ADDRESS` | LiquidationRouter; its `owner` must be this bot's signer | flash | — |
| `FLASH_SWAP_VENUE_ADDRESS` | UniswapV4SwapVenue bound to that router | flash | — |
| `FLASH_SWAP_POOLS` | `token:currency0:currency1:fee:tickSpacing[:hooks]`, comma-separated. Each pool must be WBTC/`<token>` | flash | — |
| `WBTC_FLASH_LOAN_ADDRESS` | Venue WBTC is flash-loaned from for the LLP fairness payment | flash | — |
| `WBTC_FLASH_LOAN_VENUE` | `morpho` or `aavev3` | No | `morpho` |
| `FLASH_MAX_SLIPPAGE_BPS` | How far the realised profit may fall below the probe's quote before the chain reverts. Derives the on-chain `minWbtcProfit`, and is the only slippage bound in flash mode. Distinct from `RISK_MIN_PROFIT` — see below | No | `2000` |
| `IS_DIRECT_REDEMPTION` | `true` calls `liquidate`; otherwise calls `liquidateWithLLP` | No | `false` |
| `BTC_REDEEM_KEY` | BTC key vaults are redeemed to in direct mode | direct mode | `bytes32(0)` |
| `LLP_ADDRESS` | LLP (BTCVaultSwap) address used in LLP mode | LLP mode | `address(0)` |
| `EXECUTION_MODE` | `AUTO` signs and broadcasts; `MANUAL` persists proposals | No | `AUTO` |
| `MANUAL_EXECUTOR_ADDRESS` | Address the operator signs/broadcasts from; Safe address in `safe` custody | MANUAL only | — |
| `MANUAL_EXECUTOR_KIND` | Operator custody model: `eoa` or `safe` | MANUAL only | — |
| `MANUAL_INTENT_TTL_MS` | Expire un-actioned MANUAL proposals after this many ms; `0` disables expiry | No | `10800000` |
| `MANUAL_INTENT_STUCK_MS` | Alert on `claimed`/`submitted` MANUAL intents older than this; `0` disables | No | `3600000` |
| `SECRETS_PROVIDER` | Secret reference backend: `env` or `aws` Secrets Manager | No | `env` |
| `SIGNER_SOURCE` | AUTO signer backend: `local` or `aws` KMS | No | `local` |
| `SIGNER_KEY_REF` | Local signer secret reference; defaults to the service private-key env var | No | `LIQUIDATOR_PRIVATE_KEY` |
| `KMS_KEY_ID` | AWS KMS key id/ARN/alias for `SIGNER_SOURCE=aws` | KMS only | — |
| `SIGNER_ADDRESS` | Expected signer address; boot fails if the key derives a different one. Applies to both `local` and `aws` — with the key behind a secret ref or a KMS id, the account it derives is invisible until something derives it | No | — |
| `AWS_REGION` | AWS region for KMS and Secrets Manager | No | — |
| `DATABASE_URL` | Enables Postgres StateStore for intent idempotency and reconcile-on-boot | MANUAL only | — |
| `PERSISTENCE_SCHEMA` | Schema for bot StateStore tables, separate from Ponder. **One schema per signer** — a schema is claimed by the first execution identity to use it and a second one fails at boot, because intents in it are keyed and reconciled as a single account. Running both services against one `DATABASE_URL` therefore needs a distinct value here for each. | No | `bot` |
| `NOTIFIER` | Notification backend: `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for Slack webhook URL | if `NOTIFIER=slack` | — |
| `RISK_MAX_CONSECUTIVE_FAILURES` | Auto-halt after this many consecutive failed actions | No | — |
| `RISK_MIN_PROFIT` | Profit floor in 8-decimal sats. **Not usable in this service** — the liquidation engine cannot supply an expected profit, so setting it is rejected at boot rather than silently ignored | must be unset | — |
| `RISK_MAX_IN_FLIGHT` | Max in-flight actions reserved through the risk gate. Unset = no cap. Size above the largest cascade you want to compete in | No | unlimited |
| `RISK_MAX_DATA_STALENESS_MS` | Block actions whose indexer/source data is too old, missing, malformed, or dated in the future | No | — |
| `RISK_START_HALTED` | Boot HALTED until resumed; `true` requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | Pinned bytecode map: `address=keccak256(bytecode),...` — must name at least one contract when set, since an empty map would run the checker against nothing | No | — |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval for pinned bytecode | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference enabling authenticated `/halt`, `/resume`, `/status` | if `RISK_START_HALTED=true` | — |
| `RISK_CONTROL_PORT` | Kill-switch server port, separate from `METRICS_PORT` | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host; loopback by default | No | `127.0.0.1` |
| `POLLING_INTERVAL_MS` | How often to check positions | No | `12000` |
| `TX_RECEIPT_TIMEOUT_MS` | How long to wait for each tx receipt | No | `120000` |
| `METRICS_PORT` | HTTP server port for metrics/health | No | `9090` |
| `METRICS_HOST` | Interface that server binds. Unset ⇒ every interface. `/metrics` is unauthenticated and labels carry the signer/treasury addresses and their balances, so restrict it where no network policy does | No | all interfaces |

### 5.4. Execution Modes

`EXECUTION_MODE=AUTO` is the default keeper mode: the process resolves a signer
from `SIGNER_SOURCE`, signs approvals and liquidation transactions, broadcasts
them, and waits for receipts. (Under `flash` funding there are no approvals to
sign — the bot never moves its own tokens.)

`EXECUTION_MODE=MANUAL` is keyless. The bot must have `DATABASE_URL`,
`MANUAL_EXECUTOR_ADDRESS`, and `MANUAL_EXECUTOR_KIND`; it must not have a signer
configured or the effective private-key env var present. Instead of broadcasting,
it writes a content-hashed proposal to the StateStore and sends a notification.
The operator uses `operator-cli` against the same `DATABASE_URL` and
`PERSISTENCE_SCHEMA`:

```bash
pnpm --filter @services/operator-cli operator-cli list
pnpm --filter @services/operator-cli operator-cli show <id>
pnpm --filter @services/operator-cli operator-cli claim <id>
pnpm --filter @services/operator-cli operator-cli broadcast <id>
# or, after signing externally:
pnpm --filter @services/operator-cli operator-cli confirm <id> --tx <hash>
```

### 5.5. MEV protection (private submission)

Identical to the arbitrageur's, and configured with the same variables —
`SUBMITTER`, `FLASHBOTS_PROTECT_URL`, `PRIVATE_MIN_PRIORITY_FEE_WEI`,
`PRIVATE_RELAY_HORIZON_BLOCKS`, `PRIVATE_RECLAIM_MARGIN_BLOCKS` — including the
accepted risk that releasing a nonce trusts the relay to stop offering the
transaction. Liquidation is the more contested path of the two, so
the reach-versus-protection trade-off matters more here, not less: read
[§5.5 of the arbitrageur guide](arbitrageur-operation-guide.md#55-mev-protection-private-submission)
before enabling it, including what a stuck private nonce looks like.

### 5.6. Contract Addresses

Testnet contract addresses are provided as part of the onboarding requirements.

| Contract | Purpose |
|----------|---------|
| `SPOKE_ADDRESS` | Core Spoke — tracks positions via Supply/Withdraw events |
| `ADAPTER_ADDRESS` | AaveAdapter — entry point for `liquidate()` / `liquidateWithLLP()` calls |
| `LENS_ADDRESS` | AaveAdapterLens — pre-computes liquidation amounts via `estimateLiquidation()` |
| `WBTC_ADDRESS` | WBTC token for balance monitoring |

## 6. Wallet Setup

### 6.1. Funding Requirements

What the wallet must hold depends on `LIQUIDATION_FUNDING`.

**`inventory` (default)** — the bot repays from its own balances:

| Asset | Purpose | Notes |
|-------|---------|-------|
| **ETH** | Transaction gas | Monitor balance for continuous operation |
| **Debt Tokens** | Repay borrower debt during liquidation | USDC, USDT, etc. A position larger than your balance is skipped |
| **WBTC** | LLP fairness payment, and the redemption fee in direct mode | Pulled from `msg.sender` by the adapter |

**`flash`** — `LiquidationRouter` borrows each debt token from a venue and repays that venue out of
the seized collateral within the same transaction, so the wallet holds no trading inventory at all:

| Asset | Purpose | Notes |
|-------|---------|-------|
| **ETH** | Transaction gas | The only balance the bot needs |

Two things to get right in `flash` mode instead of funding the wallet:

- The router's immutable `owner` must be this bot's signer. The router accepts calls from nobody
  else, and sweeps all profit to it — so profit accrues to the signer as WBTC, and the wallet's
  WBTC balance grows rather than being spent.
- Each entry in `FLASH_SWAP_POOLS` must be a WBTC/`<debtToken>` pool with enough depth that a
  liquidation-sized swap does not move the price past `FLASH_MAX_SLIPPAGE_BPS`. The venue is a flash
  *swap*: it repays in the pool's other side. A thin pool does not fail loudly — the bot correctly
  declines the liquidation as unprofitable, which looks like the bot doing nothing.

**Recommended monitoring:**
- Set up alerts for low ETH balance
- Under `inventory` funding, monitor debt token balances via `liquidator_token_balance`. Under
  `flash` those balances are not funding capacity, so do not alert on them being low — alert on
  liquidations failing instead
- In MANUAL mode, monitor proposals with `operator-cli list` and Slack/log notifications

## 7. Starting the Service

### 7.1. Native Deployment

**Step 1: Start PostgreSQL**

```bash
pnpm liquidator:db:up
```

**Step 2: Start Ponder Indexer**

```bash
pnpm liquidator:indexer
```

Wait for initial sync (check logs for "Indexing complete" or query `/positions` endpoint).

**Step 3: Start Liquidation Client**

```bash
pnpm liquidator:run
```

**Verify startup:**

```bash
# Check health
curl http://localhost:9090/health

# Check positions being tracked
curl http://localhost:42069/positions
```

### 7.2. Docker Deployment

**Start all liquidator services:**

```bash
docker compose up -d liquidator-postgres liquidator-ponder liquidator-bot
```

**View logs:**

```bash
# All liquidator services
docker compose logs -f liquidator-ponder liquidator-bot

# Specific service
docker compose logs -f liquidator-bot
```

**Service dependencies:**
- `liquidator-postgres` must be healthy before `liquidator-ponder` starts
- `liquidator-ponder` must be healthy before `liquidator-bot` starts

**Health checks are automatic** - Docker will restart unhealthy containers.

## 8. Operations

### 8.1. Health Monitoring

**Health endpoint:**

```bash
curl http://localhost:9090/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "lastPollAt": "2025-01-30T12:00:00.000Z",
  "ponderReachable": true,
  "rpcReachable": true,
  "latestBlockNumber": "19500000"
}
```

| Status | Meaning |
|--------|---------|
| `healthy` | All dependencies reachable, polling active |
| `degraded` | Some issues but still operational |
| `unhealthy` | Critical failures, not operational |

**Readiness endpoint:**

```bash
curl http://localhost:9090/ready
```

Returns HTTP 200 if ready, HTTP 503 if dependencies unreachable.

### 8.2. Prometheus Metrics

Available at `GET http://localhost:9090/metrics`

The risk-control kill switch, when enabled, is not served from this port. It
listens on `RISK_CONTROL_HOST:RISK_CONTROL_PORT` and requires a bearer token.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `eth_rpc_calls_total` | Counter | Outbound JSON-RPC attempts by `method` (retries counted separately) |
| `submitter_send_total` | Counter | Broadcast attempts by `result` (`accepted`/`rejected`/`ambiguous`) — private submission only; see §5.5 |
| `relay_tx_status_total` | Counter | Relay status by `status`, plus `sim_error` (our tx is unviable) and `probe_error` (relay unreachable) |
| `liquidator_positions_checked` | Gauge | Positions checked in last poll |
| `liquidator_positions_liquidatable` | Gauge | Liquidatable positions found |
| `liquidator_liquidations_total` | Counter | Successful liquidations |
| `liquidator_liquidations_failed_total` | Counter | Failed liquidation attempts |
| `liquidator_simulations_failed_total` | Counter | Failed simulations |
| `liquidator_token_balance` | Gauge | Current token balances |
| `liquidator_errors_total` | Counter | Errors by type |
| `liquidator_poll_duration_seconds` | Histogram | Poll cycle duration |
| `liquidator_last_poll_timestamp` | Gauge | Last poll timestamp |

**Recommended alerts:**

```yaml
# Prometheus alerting rules example
- alert: LiquidatorNotPolling
  expr: time() - liquidator_last_poll_timestamp > 60
  for: 2m
  annotations:
    summary: "Liquidator has not polled in over 60 seconds"

- alert: LiquidatorHighErrorRate
  expr: rate(liquidator_errors_total[5m]) > 0.1
  annotations:
    summary: "Liquidator experiencing high error rate"

- alert: LiquidatorLowBalance
  expr: liquidator_token_balance{token="ETH"} < 0.1
  annotations:
    summary: "Liquidator ETH balance low"
```

### 8.3. Manual Commands

**MANUAL proposals:**

```bash
# Proposals awaiting an operator
pnpm --filter @services/operator-cli operator-cli list --action liquidation

# Inspect and claim a proposal before signing
pnpm --filter @services/operator-cli operator-cli show <id>
pnpm --filter @services/operator-cli operator-cli claim <id>

# Broadcast with configured operator keys, or record an externally signed tx
pnpm --filter @services/operator-cli operator-cli broadcast <id>
pnpm --filter @services/operator-cli operator-cli confirm <id> --tx <hash>
```

The CLI uses `CLIENT_RPC_URL`, `DATABASE_URL`, `PERSISTENCE_SCHEMA`,
`MANUAL_EXECUTOR_ADDRESS`, and `MANUAL_EXECUTOR_KIND`. `broadcast` additionally
needs `OPERATOR_KEY_REF` for EOA custody or `SAFE_OWNER_KEY_REFS` for Safe
custody; `claim` and `confirm` can remain keyless.

**Risk-control kill switch:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9095/status
curl -XPOST -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:9095/halt?reason=incident"
curl -XPOST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9095/resume
```

`GET /status` answers `{state, inFlight, reason, codeVerified}`. Read `reason`
before resuming: a halt recorded while the gate was *already* HALTED — a
code-hash mismatch found under `RISK_START_HALTED=true`, say — raises no alert,
so this is the only place it is ever stated. `codeVerified` is `true` once every
address in `RISK_EXPECTED_CODE_HASHES` has passed a bytecode check in this
process — and `false` both before that and when no hashes are pinned at all,
since neither is an assurance about the code you are trading against.

`POST /resume` clears the kill switch, and only the kill switch. It answers
**409** and leaves the bot HALTED when the code-hash guard is what is holding
the halt — a mismatched, missing or never-readable target is not something to
wave through by hand. That clears itself: the next successful check retires the
cause, and the resume then works — so a flaky RPC costs you one check interval,
not an outage. If the pinned hash is simply *wrong*, correct
`RISK_EXPECTED_CODE_HASHES` and restart; no amount of resuming will clear a
mismatch that is really there.

**A code-hash halt also withdraws the adapter's allowances.** While that halt
stands, every poll cycle sends `approve(adapter, 0)` for each token whose
allowance is not already zero — the debt tokens and WBTC. This is the one
transaction a HALTED gate still sends, and it is the only one it can: a halt
stops what the bot sends, and the adapter needs nothing further from the bot to
pull what it was already approved for. An operator kill-switch halt does **not**
do this. Under `EXECUTION_MODE=MANUAL` the withdrawal is a proposal to sign, not
a transaction, so expect one alert per token. Once the pin is corrected and the
gate resumes, the next cycle re-approves what it needs.

**Query indexer endpoints:**

```bash
# All positions in the indexer's table
curl http://localhost:42069/positions

# Positions for which Lens.estimateLiquidation succeeds, enriched with
# the amounts/vaults the bot will pass to liquidate / liquidateWithLLP
curl http://localhost:42069/liquidatable-positions
```

The response's `checked` counts the positions the scan has an answer for and
`unscanned` the ones it does not: a batch that failed as a whole, plus any probe
that reverted for a reason other than the position being healthy. The indexer
probes the table in batches (`POSITION_PROBE_CHUNK_SIZE`, default 25) so one
node-side `eth_call` gas cap cannot sink the whole scan; a nonzero `unscanned`
means the candidate list is incomplete for that request.

A healthy position reverts by design — that is how the lens reports one — and is
counted as checked. Everything else that reverts is a deployment that cannot
answer the question rather than an answer: a reserve whose oracle reads zero, a
paused dependency, a `LENS_ADDRESS` pointing at the wrong contract. The indexer
logs one line per cycle naming the causes and their counts, and the positions go
to `unscanned`, so a fault of that kind can never present as a quiet market.

The default is measured: ~177k gas per healthy probe against a five-reserve
spoke, rising ~21k per extra spoke reserve and ~3k per vault on the position,
with a liquidatable position costing ~247k. Batching does not amortise that, so
25 keeps a batch near 4.4M gas — inside the 50M cap geth defaults to and the 10M
some providers enforce. Raise it only against a known node cap.

## 9. Troubleshooting

### 9.1. Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Ponder unreachable" | Indexer not running or wrong URL | Check `PONDER_URL`, verify indexer is healthy |
| "RPC unreachable" | Invalid RPC endpoint | Verify `CLIENT_RPC_URL` and network connectivity |
| "Transaction reverted" | Insufficient balance or position already liquidated | Check wallet balance, verify position still liquidatable |
| "Simulation failed" | Position state changed | Normal - competition from other liquidators |
| "Missing required environment variable" | Configuration error | Check `.env.liquidator` for missing values |
| "EXECUTION_MODE=MANUAL requires DATABASE_URL" | MANUAL proposals need durable storage | Set `DATABASE_URL` and matching `PERSISTENCE_SCHEMA` |
| "EXECUTION_MODE=MANUAL is keyless" | A signer or private key is present in MANUAL | Unset signer env and the effective private-key env var |
| Liquidations missed while positions were unhealthy | The indexer had no answer for those positions — a probe batch failed, or the probes reverted for a reason other than "healthy" (`liquidator_errors_total{type="positions_unscanned"}`) | Check the indexer log for "failed as a whole" (RPC `eth_call` gas cap) or "for a reason other than the position being healthy", which names the revert — an oracle at zero or a wrong `LENS_ADDRESS` reverts every probe. The next cycle retries |
| "halted (...)" | Risk gate is HALTED | `GET /status` and read `reason` — it is the only record of a halt raised while already HALTED; then `POST /resume` if appropriate (409 means the code-hash guard is holding it) |

### 9.2. Error Types

| Error Type | Trigger | Action |
|------------|---------|--------|
| `poll_error` | Exception escaped the poll cycle | Check logs for stack trace |
| `ponder_fetch_error` | Failed to fetch from indexer | Verify Ponder is running |
| `lens_estimate_error` | `Lens.estimateLiquidation` reverted for a candidate | Usually transient; position state changed |
| `risk_blocked` | Risk gate blocked an otherwise executable candidate | Check risk config and kill-switch state |
| `intent_in_flight` | Existing live intent/proposal already owns this subject | Let reconcile/operator workflow finish, or inspect the StateStore |
| `tx_send_error` | Failed to broadcast the liquidation transaction | Check RPC connectivity, wallet balance |
| `tx_reverted` | Transaction reverted on-chain | Position may already be liquidated |
| `receipt_fetch_error` | Failed to fetch transaction receipt | Check RPC connectivity |

**Viewing logs:**

```bash
# Native
# Logs output to stdout

# Docker
docker compose logs -f liquidator-bot --tail 100
```
