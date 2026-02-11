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
   - [Contract Addresses](#54-contract-addresses)
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
| **Ponder Indexer** | Indexes blockchain events (`Supply`, `Withdraw`, `LiquidationCall`) and tracks all active positions with collateral |
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
| PostgreSQL | Ponder indexer data storage | `localhost:5432` |

### 2.3. Network Requirements

**Ports:**

| Port | Protocol | Purpose |
|------|----------|---------|
| 42069 | HTTP | Ponder indexer API |
| 9090 | HTTP | Metrics, health, and readiness endpoints |
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
│  - Simulates liquidations               │
│  - Executes liquidateCorePosition()     │
│  - Optionally swaps vaults for WBTC     │
│  - Exposes /metrics, /health, /ready    │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│      Aave Integration Controller        │
│  - Entry point for liquidations         │
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
│   └── liquidator/
│       ├── client/          # Liquidation bot
│       └── ponder/          # Blockchain indexer
├── packages/
│   └── shared/              # Shared utilities
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
| Ponder | `services/liquidator/ponder/.env.local` | Indexer settings |

**Create configuration files:**

```bash
# Copy template
cp env.liquidator.example .env.liquidator

# Create Ponder env (copy relevant vars from .env.liquidator)
cp .env.liquidator services/liquidator/ponder/.env.local
```

### 5.2. Ponder Indexer Configuration

Configure the indexer in `services/liquidator/ponder/.env.local`:

```bash
# RPC URL for blockchain indexing
PONDER_RPC_URL=https://eth-mainnet.example.com

# Core Spoke contract address (Babylon's dedicated Spoke)
SPOKE_ADDRESS=0x...

# AaveIntegrationController address
CONTROLLER_ADDRESS=0x...

# Chain ID
CHAIN_ID=1

# Block number to start indexing from
START_BLOCK=20000000

# Blockchain polling interval (milliseconds)
PONDER_POLLING_INTERVAL=1000

# PostgreSQL connection
DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder
DATABASE_SCHEMA=public
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `PONDER_RPC_URL` | Ethereum RPC endpoint for indexing | Required |
| `SPOKE_ADDRESS` | Babylon's Aave Core Spoke contract | Required |
| `CONTROLLER_ADDRESS` | AaveIntegrationController contract | Required |
| `CHAIN_ID` | Network chain ID | `1` |
| `START_BLOCK` | Block to begin indexing | `0` |
| `PONDER_POLLING_INTERVAL` | How often to poll for new blocks (ms) | `1000` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `DATABASE_SCHEMA` | PostgreSQL schema | `public` |

### 5.3. Liquidation Client Configuration

Configure the client in `.env.liquidator`:

```bash
# ====== Required ======

# Private key of liquidator wallet
LIQUIDATOR_PRIVATE_KEY=0x...

# Ponder indexer API URL
PONDER_URL=http://localhost:42069

# RPC URL for transaction execution
CLIENT_RPC_URL=https://eth-mainnet.example.com

# Contract addresses
CONTROLLER_ADDRESS=0x...
VAULT_SWAP_ADDRESS=0x...
WBTC_ADDRESS=0x...

# ====== Optional ======

# Debt token addresses (comma-separated)
# Auto-discovered from Spoke if not set
# DEBT_TOKEN_ADDRESSES=0xUSDC...,0xUSDT...

# Auto-swap seized vaults for WBTC (default: true)
AUTO_SWAP=true

# Position check frequency (default: 10000ms)
POLLING_INTERVAL_MS=10000

# Metrics server port (default: 9090)
METRICS_PORT=9090
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `LIQUIDATOR_PRIVATE_KEY` | Private key for signing transactions | Required |
| `PONDER_URL` | Indexer API endpoint | Required |
| `CLIENT_RPC_URL` | RPC for transaction execution | Required |
| `CONTROLLER_ADDRESS` | AaveIntegrationController address | Required |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address | Required |
| `WBTC_ADDRESS` | WBTC token address | Required |
| `DEBT_TOKEN_ADDRESSES` | Override auto-discovery (comma-separated) | Auto-discovered |
| `AUTO_SWAP` | Swap vaults for WBTC after liquidation | `true` |
| `POLLING_INTERVAL_MS` | How often to check positions | `10000` |
| `METRICS_PORT` | HTTP server port for metrics/health | `9090` |

### 5.4. Contract Addresses

Testnet contract addresses are provided as part of the onboarding requirements.

| Contract | Purpose |
|----------|---------|
| `SPOKE_ADDRESS` | Core Spoke - tracks positions via Supply/Withdraw events |
| `CONTROLLER_ADDRESS` | Entry point for `liquidateCorePosition()` calls |
| `VAULT_SWAP_ADDRESS` | Instant vault-to-WBTC swap via `swapVaultForWbtc()` |
| `WBTC_ADDRESS` | WBTC token for swap settlements |

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

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `liquidator_positions_checked` | Gauge | Positions checked in last poll |
| `liquidator_positions_liquidatable` | Gauge | Liquidatable positions found |
| `liquidator_liquidations_total` | Counter | Successful liquidations |
| `liquidator_liquidations_failed_total` | Counter | Failed liquidation attempts |
| `liquidator_simulations_failed_total` | Counter | Failed simulations |
| `liquidator_vaults_seized_total` | Counter | Vaults seized from liquidations |
| `liquidator_vaults_swapped_total` | Counter | Vaults swapped for WBTC |
| `liquidator_wbtc_received_total` | Counter | WBTC received (satoshis) |
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

**List owned vaults:**

```bash
pnpm liquidator:list-owned
```

**Manually swap a vault for WBTC:**

```bash
pnpm liquidator:swap -- <vaultId>
```

**Query indexer endpoints:**

```bash
# All positions
curl http://localhost:42069/positions

# Liquidatable positions only
curl http://localhost:42069/liquidatable-positions

# Positions with live health factors
curl http://localhost:42069/positions-health

# Vaults owned by specific address
curl "http://localhost:42069/owned-vaults?owner=0x..."
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

### 9.2. Error Types

| Error Type | Trigger | Action |
|------------|---------|--------|
| `poll_error` | Exception in poll cycle | Check logs for stack trace |
| `ponder_fetch_error` | Failed to fetch from indexer | Verify Ponder is running |
| `tx_send_error` | Failed to send transaction | Check RPC connectivity, wallet balance |
| `tx_reverted` | Transaction reverted on-chain | Position may already be liquidated |
| `swap_error` | Failed vault swap | Check WBTC balance, contract approval |

**Viewing logs:**

```bash
# Native
# Logs output to stdout

# Docker
docker compose logs -f liquidator-client --tail 100
```
