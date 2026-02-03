# Arbitrageur Operation Guide

This guide covers the operation of the arbitrageur service for the Aave v4 integration
with Babylon's Trustless Bitcoin Vaults protocol.

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
   - [Arbitrageur Client Configuration](#53-arbitrageur-client-configuration)
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
9. [Vault Acquisition Flow](#9-vault-acquisition-flow)
    - [Economic Model](#91-economic-model)
    - [Interest Accrual](#92-interest-accrual)
10. [Troubleshooting](#10-troubleshooting)
    - [Common Issues](#101-common-issues)
    - [Error Types](#102-error-types)

## 1. Introduction

The arbitrageur service monitors escrowed BTC vaults and acquires them at a discount
using WBTC. Escrowed vaults are created when liquidators swap seized vaults for
instant WBTC liquidity via the Swap Spoke.

The service consists of two components:

| Component | Description |
|-----------|-------------|
| **Ponder Indexer** | Indexes blockchain events (`VaultSwappedForWbtc`, `WbtcSwappedForVault`) and tracks escrowed vaults available for acquisition |
| **Arbitrageur Client** | Polls the indexer for profitable vaults and executes acquisition transactions |

> **Note**: A vault keeper daemon must be running to complete vault redemptions. The keeper listens for redemption events and handles the off-chain claim process.

> **Important**: The trustless Bitcoin vaults protocol requires all entities that may claim a BTC vault to pre-sign a set of transactions during the vault's creation. This restricts claims to a pre-approved set of participants controlled by the smart contract admin, making the arbitrageur role **permissioned**.

## 2. System Requirements

### 2.1. Hardware Specifications

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| Ponder Indexer | 2 vCPUs | 4 GB | 20 GB SSD |
| Arbitrageur Client | 1 vCPU | 1 GB | 10 GB SSD |
| PostgreSQL | 2 vCPUs | 4 GB | 50 GB SSD |

> **Note**: These are recommended minimum values. Adjust based on your workload and monitoring observations.

### 2.2. External Service Connections

| Service | Purpose | Default Endpoint |
|---------|---------|------------------|
| Ethereum RPC | Event indexing, transaction execution | Configurable |
| PostgreSQL | Ponder indexer data storage | `localhost:5433` |

### 2.3. Network Requirements

**Ports:**

| Port | Protocol | Purpose |
|------|----------|---------|
| 42070 | HTTP | Ponder indexer API |
| 9091 | HTTP | Metrics, health, and readiness endpoints |
| 5433 | TCP | PostgreSQL database |

## 3. Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ethereum RPC  │     │   PostgreSQL    │     │  Swap Spoke     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       │
┌─────────────────────────────────────────┐              │
│           Ponder Indexer                │              │
│  - Indexes VaultSwap events             │              │
│  - Tracks escrowed vaults               │              │
│  - Calculates live debt with interest   │              │
│  - Exposes /escrowed-vaults API         │              │
└────────────────────┬────────────────────┘              │
                     │                                   │
                     ▼                                   │
┌─────────────────────────────────────────┐              │
│         Arbitrageur Client              │              │
│  - Polls indexer at configured interval │              │
│  - Evaluates vault profitability        │              │
│  - Executes swapWbtcForVault()          │──────────────┘
│  - Optionally initiates redemption      │
│  - Exposes /metrics, /health, /ready    │
└─────────────────────────────────────────┘
```

## 4. Installation

### 4.1. Prerequisites

- **Node.js**: >= 18.14 (22 LTS recommended)
- **pnpm**: 9.13.2+
- **Docker** (for containerized deployment)
- **PostgreSQL**: 17+ (or use Docker)
- **Registration**: Must be registered as Aave keeper (see [Introduction](#1-introduction))

### 4.2. Native Installation

**Clone and install dependencies:**

```bash
# TODO: Add release tag once we create a release (e.g., --branch v1.0.0)
git clone https://github.com/babylonlabs-io/aave-v4-bots.git
cd aave-v4-bots
pnpm install
```

**Directory structure:**

```
aave-v4-bots/
├── services/
│   └── arbitrageur/
│       ├── client/          # Arbitrageur bot
│       └── ponder/          # Blockchain indexer
├── packages/
│   └── shared/              # Shared utilities
├── .env.arbitrageur         # Client configuration
└── docker-compose.yml       # Docker orchestration
```

### 4.3. Docker Installation

Pre-built images are available from GitHub Container Registry:

| Image | Description |
|-------|-------------|
| `ghcr.io/babylonlabs-io/arbitrageur-aave-indexer` | Ponder indexer |
| `ghcr.io/babylonlabs-io/arbitrageur-aave-client` | Arbitrageur client |

Docker Compose will automatically pull these images. To build locally instead:

```bash
docker compose build arbitrageur-ponder arbitrageur-client
```

## 5. Configuration

### 5.1. Environment Files

The service requires two environment configurations:

| Component | File Location | Purpose |
|-----------|---------------|---------|
| Client | `.env.arbitrageur` (root) | Arbitrageur client settings |
| Ponder | `services/arbitrageur/ponder/.env.local` | Indexer settings |

**Create configuration files:**

```bash
# Copy template
cp env.arbitrageur.example .env.arbitrageur

# Create Ponder env (copy relevant vars from .env.arbitrageur)
cp .env.arbitrageur services/arbitrageur/ponder/.env.local
```

### 5.2. Ponder Indexer Configuration

Configure the indexer in `services/arbitrageur/ponder/.env.local`:

```bash
# RPC URL for blockchain indexing
PONDER_RPC_URL=https://eth-mainnet.example.com

# VaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# BTCVaultsManager contract address
BTC_VAULTS_MANAGER_ADDRESS=0x...

# Chain ID (1 for mainnet, 11155111 for Sepolia testnet)
CHAIN_ID=1

# Block number to start indexing from
START_BLOCK=20000000

# Blockchain polling interval (milliseconds)
PONDER_POLLING_INTERVAL=1000

# PostgreSQL connection (note: port 5433 to avoid conflict with liquidator)
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder
DATABASE_SCHEMA=public
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `PONDER_RPC_URL` | Ethereum RPC endpoint for indexing | Required |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address | Required |
| `BTC_VAULTS_MANAGER_ADDRESS` | BTCVaultsManager contract | Required |
| `CHAIN_ID` | Network chain ID (1 for mainnet, 11155111 for Sepolia) | `1` |
| `START_BLOCK` | Block to begin indexing | `0` |
| `PONDER_POLLING_INTERVAL` | How often to poll for new blocks (ms) | `1000` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `DATABASE_SCHEMA` | PostgreSQL schema | `public` |

### 5.3. Arbitrageur Client Configuration

Configure the client in `.env.arbitrageur`:

```bash
# ====== Required ======

# Private key of arbitrageur wallet (must be registered as keeper)
ARBITRAGEUR_PRIVATE_KEY=0x...

# Ponder indexer API URL
PONDER_URL=http://localhost:42070

# RPC URL for transaction execution
CLIENT_RPC_URL=https://eth-mainnet.example.com

# Contract addresses
CONTROLLER_ADDRESS=0x...
VAULT_SWAP_ADDRESS=0x...
WBTC_ADDRESS=0x...

# ====== Optional ======

# Maximum slippage in basis points (default: 100 = 1%)
MAX_SLIPPAGE_BPS=100

# Auto-initiate redemption after acquisition (default: true)
AUTO_REDEEM=true

# Vault check frequency (default: 30000ms = 30 seconds)
POLLING_INTERVAL_MS=30000

# Delay between processing multiple vaults (default: 5000ms)
VAULT_PROCESSING_DELAY_MS=5000

# Metrics server port (default: 9091)
METRICS_PORT=9091

# ====== Retry Configuration (Optional) ======

# Maximum retry attempts (default: 3)
RETRY_MAX_ATTEMPTS=3

# Initial retry delay in milliseconds (default: 1000)
RETRY_INITIAL_DELAY_MS=1000

# Maximum retry delay in milliseconds (default: 30000)
RETRY_MAX_DELAY_MS=30000

# Transaction receipt timeout in milliseconds (default: 120000 = 2 minutes)
TX_RECEIPT_TIMEOUT_MS=120000
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ARBITRAGEUR_PRIVATE_KEY` | Private key for signing transactions | Required |
| `PONDER_URL` | Indexer API endpoint | Required |
| `CLIENT_RPC_URL` | RPC for transaction execution | Required |
| `CONTROLLER_ADDRESS` | AaveIntegrationController address | Required |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address | Required |
| `WBTC_ADDRESS` | WBTC token address | Required |
| `MAX_SLIPPAGE_BPS` | Maximum slippage tolerance (basis points) | `100` (1%) |
| `AUTO_REDEEM` | Auto-initiate redemption after acquisition | `true` |
| `POLLING_INTERVAL_MS` | How often to check for vaults | `30000` |
| `VAULT_PROCESSING_DELAY_MS` | Delay between vault acquisitions | `5000` |
| `METRICS_PORT` | HTTP server port for metrics/health | `9091` |
| `RETRY_MAX_ATTEMPTS` | Max retry attempts on failure | `3` |
| `RETRY_INITIAL_DELAY_MS` | Initial retry delay | `1000` |
| `RETRY_MAX_DELAY_MS` | Maximum retry delay | `30000` |
| `TX_RECEIPT_TIMEOUT_MS` | Transaction receipt timeout | `120000` |

### 5.4. Contract Addresses

Testnet contract addresses are provided as part of the onboarding requirements.

| Contract | Purpose |
|----------|---------|
| `VAULT_SWAP_ADDRESS` | Execute `swapWbtcForVault()` to acquire vaults |
| `BTC_VAULTS_MANAGER_ADDRESS` | Vault redemption and management |
| `CONTROLLER_ADDRESS` | Verify vault ownership, initiate redemption |
| `WBTC_ADDRESS` | WBTC token for acquisition payments |

## 6. Wallet Setup

### 6.1. Funding Requirements

The arbitrageur wallet requires:

| Asset | Purpose | Notes |
|-------|---------|-------|
| **ETH** | Transaction gas | Monitor balance for continuous operation |
| **WBTC** | Vault acquisition payments | Must have sufficient balance to acquire vaults |

**WBTC requirements:**
- Vaults are acquired at a discount (see [Economic Model](#101-economic-model) for details)
- Maintain buffer for multiple simultaneous acquisitions
- Monitor `arbitrageur_wbtc_balance` metric

**Recommended monitoring:**
- Set up alerts for low ETH balance
- Set up alerts for low WBTC balance

## 7. Starting the Service

### 7.1. Native Deployment

**Step 1: Start PostgreSQL**

```bash
pnpm arbitrageur:db:up
```

**Step 2: Start Ponder Indexer**

```bash
pnpm arbitrageur:indexer
```

Wait for initial sync (check logs or query `/escrowed-vaults` endpoint).

**Step 3: Start Arbitrageur Client**

```bash
pnpm arbitrageur:run
```

**Verify startup:**

```bash
# Check health
curl http://localhost:9091/health

# Check escrowed vaults being tracked
curl http://localhost:42070/escrowed-vaults
```

### 7.2. Docker Deployment

**Start all arbitrageur services:**

```bash
docker compose up -d arbitrageur-postgres arbitrageur-ponder arbitrageur-client
```

**Or start everything (including liquidator):**

```bash
docker compose up -d
```

**View logs:**

```bash
# All arbitrageur services
docker compose logs -f arbitrageur-ponder arbitrageur-client

# Specific service
docker compose logs -f arbitrageur-client
```

**Service dependencies:**
- `arbitrageur-postgres` must be healthy before `arbitrageur-ponder` starts
- `arbitrageur-ponder` must be healthy before `arbitrageur-client` starts

**Health checks are automatic** - Docker will restart unhealthy containers.

## 8. Operations

### 8.1. Health Monitoring

**Health endpoint:**

```bash
curl http://localhost:9091/health
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
curl http://localhost:9091/ready
```

Returns HTTP 200 if ready, HTTP 503 if dependencies unreachable.

### 8.2. Prometheus Metrics

Available at `GET http://localhost:9091/metrics`

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `arbitrageur_vaults_acquired_total` | Counter | Total vaults acquired |
| `arbitrageur_wbtc_spent_total` | Counter | Total WBTC spent (satoshis) |
| `arbitrageur_wbtc_balance` | Gauge | Current WBTC balance (satoshis) |
| `arbitrageur_errors_total` | Counter | Errors by type |
| `arbitrageur_poll_duration_seconds` | Histogram | Poll cycle duration |
| `arbitrageur_last_poll_timestamp` | Gauge | Last poll timestamp |

**Recommended alerts:**

```yaml
# Prometheus alerting rules example
- alert: ArbitrageurNotPolling
  expr: time() - arbitrageur_last_poll_timestamp > 120
  for: 2m
  annotations:
    summary: "Arbitrageur has not polled in over 2 minutes"

- alert: ArbitrageurHighErrorRate
  expr: rate(arbitrageur_errors_total[5m]) > 0.1
  annotations:
    summary: "Arbitrageur experiencing high error rate"

- alert: ArbitrageurLowWbtcBalance
  expr: arbitrageur_wbtc_balance < 10000000  # 0.1 WBTC in satoshis
  annotations:
    summary: "Arbitrageur WBTC balance low"
```

### 8.3. Manual Commands

**List owned vaults:**

```bash
pnpm arbitrageur:list-owned
```

**Verify vault ownership:**

```bash
pnpm arbitrageur:verify <vaultId>
```

**Manually initiate redemption:**

```bash
pnpm arbitrageur:redeem <vaultId>
```

**Query indexer endpoints:**

```bash
# Escrowed vaults available for acquisition
curl http://localhost:42070/escrowed-vaults

# Raw escrowed vaults (for debugging)
curl http://localhost:42070/escrowed-vaults-raw

# Vaults owned by specific address
curl "http://localhost:42070/owned-vaults?owner=0x..."
```

## 9. Vault Acquisition Flow

### 9.1. Economic Model

When acquiring a vault, the arbitrageur pays less than the full BTC value:

| Component | Example (1 BTC vault) |
|-----------|----------------------|
| Vault BTC Value | 1.00 BTC |
| Arbitrageur Pays | ~0.97 WBTC |
| **Gross Profit** | **~0.03 BTC (~3%)** |

> **Note**: The exact discount percentage is defined as a protocol parameter.
> Check the `ProtocolParam` contract on your target network for current rates.
>
> <!-- TODO: Update this when protocol params are moved to Aave contracts -->

### 9.2. Interest Accrual

The debt on an escrowed vault accrues interest over time:

```
currentDebt = principal + accruedInterest
```

The `previewWbtcToAcquireVault(vaultId)` function returns the current WBTC
required, including accrued interest.

> **Note**: Vault acquisition is first-come-first-served. The first successful
> `swapWbtcForVault()` transaction wins the vault.

## 10. Troubleshooting

### 10.1. Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Ponder unreachable" | Indexer not running or wrong URL | Check `PONDER_URL`, verify indexer is healthy |
| "RPC unreachable" | Invalid RPC endpoint | Verify `CLIENT_RPC_URL` and network connectivity |
| "Configuration validation failed" | Invalid env vars | Check error output for specific field |
| "Swap reverted" | Vault already acquired or slippage exceeded | Normal competition - vault was acquired by another |
| "Gas estimation failed" | Contract call would revert | Vault state changed, will retry |
| "Transaction timeout" | Network congestion | Increase `TX_RECEIPT_TIMEOUT_MS` |
| "Insufficient WBTC" | Low balance | Fund wallet with more WBTC |

### 10.2. Error Types

| Error Type | Trigger | Action |
|------------|---------|--------|
| `poll_error` | Exception in poll cycle | Check logs for stack trace |
| `ponder_fetch_error` | Failed to fetch from indexer | Verify Ponder is running |
| `gas_estimation_failed` | Gas estimation failed | Contract would revert, will retry |
| `tx_timeout` | Transaction receipt timeout | Check network, increase timeout |
| `acquire_error` | Failed to acquire vault | Check WBTC balance, approval |
| `swap_reverted` | Swap transaction reverted | Vault likely acquired by another |
| `redeem_error` | Failed to initiate redemption | Check keeper registration |
| `redeem_reverted` | Redeem transaction reverted | Vault state issue |
| `contract_revert` | Generic contract revert | Check transaction for reason |

**Viewing logs:**

```bash
# Native
# Logs output to stdout

# Docker
docker compose logs -f arbitrageur-client --tail 100
```
