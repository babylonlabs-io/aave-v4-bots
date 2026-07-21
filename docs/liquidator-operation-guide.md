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
| `babylonlabs/liquidator-aave-indexer` | Ponder indexer |
| `babylonlabs/liquidator-aave-client` | Liquidation client |

Docker Compose will automatically pull these images. To build locally instead:

```bash
docker compose build liquidator-ponder liquidator-client
```

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
cp env.liquidator.example .env.liquidator

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

# ====== Optional ======

# Debt token addresses (comma-separated). If unset, auto-discovered from
# the Spoke's borrowable reserves.
# DEBT_TOKEN_ADDRESSES=0xUSDC...,0xUSDT...

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
# RISK_MIN_PROFIT=0
# RISK_MAX_IN_FLIGHT=3
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
| `DEBT_TOKEN_ADDRESSES` | Override auto-discovery (comma-separated) | No | — |
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
| `SIGNER_ADDRESS` | Expected KMS signer address; boot fails on mismatch | No | — |
| `AWS_REGION` | AWS region for KMS and Secrets Manager | No | — |
| `DATABASE_URL` | Enables Postgres StateStore for intent idempotency and reconcile-on-boot | MANUAL only | — |
| `PERSISTENCE_SCHEMA` | Schema for bot StateStore tables, separate from Ponder | No | `bot` |
| `NOTIFIER` | Notification backend: `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for Slack webhook URL | if `NOTIFIER=slack` | — |
| `RISK_MAX_CONSECUTIVE_FAILURES` | Auto-halt after this many consecutive failed actions | No | — |
| `RISK_MIN_PROFIT` | Profit floor in 8-decimal sats; liquidation currently has no expected-profit input | No | — |
| `RISK_MAX_IN_FLIGHT` | Maximum in-flight actions reserved through the risk gate | No | — |
| `RISK_MAX_DATA_STALENESS_MS` | Block actions whose indexer/source data is too old or missing | No | — |
| `RISK_START_HALTED` | Boot HALTED until resumed; `true` requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | Pinned bytecode map: `address=keccak256(bytecode),...` | No | — |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval for pinned bytecode | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference enabling authenticated `/halt`, `/resume`, `/status` | if `RISK_START_HALTED=true` | — |
| `RISK_CONTROL_PORT` | Kill-switch server port, separate from `METRICS_PORT` | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host; loopback by default | No | `127.0.0.1` |
| `POLLING_INTERVAL_MS` | How often to check positions | No | `12000` |
| `TX_RECEIPT_TIMEOUT_MS` | How long to wait for each tx receipt | No | `120000` |
| `METRICS_PORT` | HTTP server port for metrics/health | No | `9090` |

### 5.4. Execution Modes

`EXECUTION_MODE=AUTO` is the default keeper mode: the process resolves a signer
from `SIGNER_SOURCE`, signs approvals and liquidation transactions, broadcasts
them, and waits for receipts.

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

### 5.5. Contract Addresses

Testnet contract addresses are provided as part of the onboarding requirements.

| Contract | Purpose |
|----------|---------|
| `SPOKE_ADDRESS` | Core Spoke — tracks positions via Supply/Withdraw events |
| `ADAPTER_ADDRESS` | AaveAdapter — entry point for `liquidate()` / `liquidateWithLLP()` calls |
| `LENS_ADDRESS` | AaveAdapterLens — pre-computes liquidation amounts via `estimateLiquidation()` |
| `WBTC_ADDRESS` | WBTC token for balance monitoring |

## 6. Wallet Setup

### 6.1. Funding Requirements

The liquidator wallet requires:

| Asset | Purpose | Notes |
|-------|---------|-------|
| **ETH** | Transaction gas | Monitor balance for continuous operation |
| **Debt Tokens** | Repay borrower debt during liquidation | USDC, USDT, etc. |

> **Note**: Flash loan support is planned for a future release, which will allow liquidators
> to borrow debt tokens from liquidity venues without upfront capital requirements.

**Recommended monitoring:**
- Set up alerts for low ETH balance
- Monitor debt token balances via `liquidator_token_balance` metric
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
docker compose up -d liquidator-postgres liquidator-ponder liquidator-client
```

**View logs:**

```bash
# All liquidator services
docker compose logs -f liquidator-ponder liquidator-client

# Specific service
docker compose logs -f liquidator-client
```

**Service dependencies:**
- `liquidator-postgres` must be healthy before `liquidator-ponder` starts
- `liquidator-ponder` must be healthy before `liquidator-client` starts

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
| `eth_rpc_calls_total` | Counter | Outbound JSON-RPC calls by `method` |
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

**Query indexer endpoints:**

```bash
# All positions in the indexer's table
curl http://localhost:42069/positions

# Positions for which Lens.estimateLiquidation succeeds, enriched with
# the amounts/vaults the bot will pass to liquidate / liquidateWithLLP
curl http://localhost:42069/liquidatable-positions
```

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
| "halted (...)" | Risk gate is HALTED | Inspect logs or `GET /status`; use `POST /resume` if appropriate |

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
docker compose logs -f liquidator-client --tail 100
```
