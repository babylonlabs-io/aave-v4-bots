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
   - [Router contract (treasury-funded acquisition only)](#44-router-contract-treasury-funded-acquisition-only)
5. [Configuration](#5-configuration)
   - [Environment Files](#51-environment-files)
   - [Ponder Indexer Configuration](#52-ponder-indexer-configuration)
   - [Arbitrageur Client Configuration](#53-arbitrageur-client-configuration)
   - [MEV protection (private submission)](#55-mev-protection-private-submission)
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
   - [Indexer Endpoints](#83-indexer-endpoints)
9. [Vault Acquisition Flow](#9-vault-acquisition-flow)
   - [Incident: signing key compromised](#91-incident-the-signing-key-is-compromised-router-funding)
    - [Economic Model](#91-economic-model)
    - [Interest Accrual](#92-interest-accrual)
10. [Troubleshooting](#10-troubleshooting)
    - [Common Issues](#101-common-issues)
    - [Error Types](#102-error-types)

## 1. Introduction

The arbitrageur service monitors escrowed BTC vaults and acquires them at a discount
using WBTC. Escrowed vaults are created when liquidators swap seized vaults for
instant WBTC liquidity via VaultSwap.

The service consists of two components:

| Component | Description |
|-----------|-------------|
| **Ponder Indexer** | Indexes blockchain events (`AddedVault`, `RemovedVault`) and tracks escrowed vaults available for acquisition |
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
| PostgreSQL | Ponder indexer data storage and optional bot StateStore | `localhost:5433` |

### 2.3. Network Requirements

**Ports:**

| Port | Protocol | Purpose |
|------|----------|---------|
| 42070 | HTTP | Ponder indexer API |
| 9091 | HTTP | Metrics, health, and readiness endpoints |
| 9095 | HTTP | Optional risk-control kill switch, loopback by default |
| 5433 | TCP | PostgreSQL database |

## 3. Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ethereum RPC  │     │   PostgreSQL    │     │   VaultSwap     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       │
┌─────────────────────────────────────────┐              │
│           Ponder Indexer                │              │
│  - Indexes AddedVault/RemovedVault     │              │
│  - Tracks escrowed vaults               │              │
│  - Enriches with live debt data         │              │
│  - Exposes /escrowed-vaults API         │              │
└────────────────────┬────────────────────┘              │
                     │                                   │
                     ▼                                   │
┌─────────────────────────────────────────┐              │
│         Arbitrageur Client              │              │
│  - Polls indexer at configured interval │              │
│  - Evaluates vault profitability        │              │
│  - AUTO: signs and broadcasts           │──────────────┘
│  - MANUAL: persists proposals for       │
│    operator-cli                         │
│  - Executes swapWbtcForVault()          │
│  - Acquisition + redemption is atomic   │
│  - (optional) also runs the liquidation │
│    engine (see note below)              │
│  - Exposes /metrics, /health, /ready    │
└─────────────────────────────────────────┘
```

**Optional liquidation engine.** When `ADAPTER_ADDRESS` + `LENS_ADDRESS` are configured, the
same process **also** runs the liquidation engine alongside arbitrage — the Ponder indexer
additionally indexes the Spoke + Adapter and serves `/liquidatable-positions`, and the client
liquidates unhealthy positions. Both engines share **one** signer, executor, nonce authority,
and risk gate, so a kill-switch halt or a tripped breaker stops **both** at once. With neither
address set, the process runs arbitrage only. See the
[Liquidator Operation Guide](./liquidator-operation-guide.md) for the liquidation pipeline.

## 4. Installation

### 4.1. Prerequisites

- **Node.js**: >= 18.14
- **pnpm**: 9.13.2+
- **PostgreSQL**: 17+
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
│   ├── arbitrageur/         # Arbitrageur bot composition root
│   ├── operator-cli/        # MANUAL-mode operator workflow
│   └── ponder/              # Unified blockchain indexer
├── packages/                # @repo/* packages by concern
├── .env.arbitrageur         # Client configuration
└── docker-compose.yml       # Docker orchestration
```

### 4.3. Docker Installation

Pre-built images are available from Docker Hub:

| Image | Description |
|-------|-------------|
| `babylonlabs/arbitrageur-aave-indexer` | Ponder indexer |
| `babylonlabs/arbitrageur-aave-bot` | Arbitrageur client |

Docker Compose will automatically pull these images. To build locally instead:

```bash
docker compose build arbitrageur-ponder arbitrageur-bot
```

### 4.4. Router contract (treasury-funded acquisition only)

Skip this under `ARBITRAGE_FUNDING=inventory` — the bot pays for acquisitions from its own WBTC and
needs no contract of its own.

Router funding moves the float off the signing key: a treasury holds the WBTC, and the bot only
signs an authorization and submits it. Deploy the router once:

```bash
export ARBITRAGE_ROUTER_SIGNER=0x...   # this bot's signer. Authorizes acquisitions; holds no funds
export ARBITRAGE_ROUTER_PAYER=0x...    # the treasury. Supplies the WBTC
export WBTC_ADDRESS=0x...              # must match the LLP's WBTC
export DEPLOYER_PRIVATE_KEY=0x...

forge script scripts/DeployArbitrageRouter.s.sol:DeployArbitrageRouter \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

**The deploy is not the whole setup.** The router can move nothing until the treasury approves it,
and only the treasury can do that:

```bash
cast send "$WBTC_ADDRESS" "approve(address,uint256)" "$ROUTER" "$AMOUNT" \
  --rpc-url "$RPC_URL" --private-key "$TREASURY_KEY"
```

Approve **working capital, not an unlimited amount.** The `vaultSwap` is an argument to each signed
call, so a compromised signer can direct the whole allowance into a contract of its choosing — the
approval is the blast radius.

All three constructor arguments are immutable and are checked against the bot's configuration at
boot, so a mismatch is a redeploy rather than a reconfiguration. There is no rotation: recovering
from a lost signer key means the treasury revokes its approval, then you deploy a new router and
point the bot at it.

Not available with `EXECUTION_MODE=MANUAL`, and rejected at boot. The router needs an EIP-712
authorization that exists *before* the transaction carrying it, which a proposal for an operator
cannot express — and that authorizing key is not one to hand a keyless bot, since it can direct the
treasury's whole allowance.

## 5. Configuration

### 5.1. Environment Files

The service requires two environment configurations:

| Component | File Location | Purpose |
|-----------|---------------|---------|
| Client | `.env.arbitrageur` (root) | Arbitrageur client settings |
| Ponder | `services/ponder/.env.local` | Indexer settings |

**Create configuration files:**

```bash
# Copy template
cp env.arbitrageur.example         .env.arbitrageur          # the bot: key, risk, submission
cp env.arbitrageur.indexer.example .env.arbitrageur.indexer  # the indexer: indexing variables only

# Create Ponder env (copy relevant vars from .env.arbitrageur)
cp .env.arbitrageur services/ponder/.env.local
```

### 5.2. Ponder Indexer Configuration

Configure the indexer in `services/ponder/.env.local`:

```bash
# RPC URL for blockchain indexing
PONDER_RPC_URL=https://eth-mainnet.example.com

# VaultSwap contract address
VAULT_SWAP_ADDRESS=0x...

# Chain ID (1 for mainnet, 11155111 for Sepolia testnet)
CHAIN_ID=1

# Block number to start indexing from
START_BLOCK=20000000

# Blockchain polling interval (milliseconds)
PONDER_POLLING_INTERVAL=4000

# PostgreSQL connection (note: port 5433 to avoid conflict with liquidator)
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder
DATABASE_SCHEMA=public
```

| Parameter | Description | Required? | Default |
|-----------|-------------|-----------|---------|
| `PONDER_RPC_URL` | Ethereum RPC endpoint for indexing | Yes | — |
| `VAULT_SWAP_ADDRESS` | VaultSwap contract address | Yes | — |
| `CHAIN_ID` | Network chain ID (1 for mainnet, 11155111 for Sepolia) | No | `1` |
| `START_BLOCK` | Block to begin indexing | No | `0` |
| `PONDER_POLLING_INTERVAL` | How often to poll for new blocks (ms) | No | `4000` |
| `DATABASE_URL` | PostgreSQL connection string | Yes | — |
| `DATABASE_SCHEMA` | PostgreSQL schema | No | `public` |

### 5.3. Arbitrageur Client Configuration

Configure the client in `.env.arbitrageur`:

```bash
# ====== Required ======

# Ponder indexer API URL
PONDER_URL=http://localhost:42070

# RPC URL for transaction execution
CLIENT_RPC_URL=https://eth-mainnet.example.com

# Contract addresses
VAULT_SWAP_ADDRESS=0x...
WBTC_ADDRESS=0x...

# ====== Optional ======

# Maximum slippage in basis points (default: 100 = 1%)
MAX_SLIPPAGE_BPS=100

# Vault check frequency (default: 30000ms = 30 seconds)
POLLING_INTERVAL_MS=30000

# Optional throttle between acquisition broadcasts (default: 0 = off; acquisitions are batched)
# VAULT_PROCESSING_DELAY_MS=0

# Metrics server port (default: 9091)
METRICS_PORT=9091

# Execution mode (default: AUTO). MANUAL is keyless and writes proposals.
EXECUTION_MODE=AUTO
# MANUAL_EXECUTOR_ADDRESS=0x...
# MANUAL_EXECUTOR_KIND=eoa
# MANUAL_INTENT_TTL_MS=10800000
# MANUAL_INTENT_STUCK_MS=3600000

# Signer and secrets (defaults: env-backed local key from ARBITRAGEUR_PRIVATE_KEY)
SECRETS_PROVIDER=env
SIGNER_SOURCE=local
ARBITRAGEUR_PRIVATE_KEY=0x...
# SIGNER_KEY_REF=ARBITRAGEUR_PRIVATE_KEY
# KMS_KEY_ID=arn:aws:kms:...
# SIGNER_ADDRESS=0x...
# AWS_REGION=us-east-1

# Persistence / crash-safety. Required in MANUAL; optional in AUTO.
DATABASE_URL=postgresql://ponder:ponder@localhost:5433/ponder
# PERSISTENCE_SCHEMA=bot

# Notifications (default: log-only)
NOTIFIER=none
# SLACK_WEBHOOK_REF=SLACK_WEBHOOK_URL

# ====== Acquisition funding ======
# inventory (default) pays for acquisitions from this signer's WBTC; router has a treasury pay
# through an ArbitrageRouter, leaving this key holding only gas. Enforced both ways: setting the
# router variables WITHOUT the flag is a boot error, since the mode is never inferred from them.
# ARBITRAGE_FUNDING=inventory
# ARBITRAGE_ROUTER_ADDRESS=0x...          # its immutable signer must be this bot's key (§4.4)
# VAULT_KEEPER_ADDRESS=0x...              # REQUIRED under router: it only redeems on behalf
# ARBITRAGE_RELAY_DEADLINE_SECONDS=120    # how long a signed batch stays valid, in chain seconds

# Optional liquidation engine, sharing the same signer/executor/risk gate
# ADAPTER_ADDRESS=0x...
# LENS_ADDRESS=0x...
# LIQUIDATION_POLLING_INTERVAL_MS=12000
# Its funding mode — inventory (default) or flash, exactly as on the liquidator. Setting flash
# without ADAPTER_ADDRESS + LENS_ADDRESS is rejected: there would be no engine to configure.
# LIQUIDATION_FUNDING=inventory
# LIQUIDATION_ROUTER_ADDRESS=0x...
# FLASH_SWAP_VENUE_ADDRESS=0x...
# FLASH_SWAP_POOLS=0xUSDC:0xWBTC:0xUSDC:3000:60
# WBTC_FLASH_LOAN_ADDRESS=0x...
# WBTC_FLASH_LOAN_VENUE=morpho
# FLASH_MAX_SLIPPAGE_BPS=2000

# Risk gate (unset variables disable their guard)
# RISK_MAX_CONSECUTIVE_FAILURES=5
# RISK_MIN_PROFIT=0
# Unset means NO cap. Bounds one poll cycle's burst; the breaker settles on receipts and so cannot
# stop the cycle already in flight. Size above the largest cascade you want to compete in.
# RISK_MAX_IN_FLIGHT=25
# RISK_MAX_DATA_STALENESS_MS=60000
# RISK_START_HALTED=false
# RISK_EXPECTED_CODE_HASHES=0xVaultSwap...=0xhash...
# RISK_CODE_CHECK_INTERVAL_MS=300000
# RISK_CONTROL_TOKEN_REF=BOT_CONTROL_TOKEN
# RISK_CONTROL_PORT=9095
# RISK_CONTROL_HOST=127.0.0.1

# ====== Retry Configuration (Optional) ======

# Maximum retry attempts (default: 3)
RETRY_MAX_ATTEMPTS=3

# Initial retry delay in milliseconds (default: 1000)
RETRY_INITIAL_DELAY_MS=1000

# Maximum retry delay in milliseconds (default: 30000). Bounds indexer reads only: the RPC
# transport takes the attempt count and initial delay, then runs viem's own uncapped schedule.
RETRY_MAX_DELAY_MS=30000

# Transaction receipt timeout in milliseconds (default: 120000 = 2 minutes)
TX_RECEIPT_TIMEOUT_MS=120000
```

| Parameter | Description | Required? | Default |
|-----------|-------------|-----------|---------|
| `ARBITRAGEUR_PRIVATE_KEY` | Default local signer key ref target; not used with KMS or MANUAL | AUTO + local | — |
| `PONDER_URL` | Indexer API endpoint | Yes | — |
| `CLIENT_RPC_URL` | RPC for transaction execution | Yes | — |
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap contract address | Yes | — |
| `WBTC_ADDRESS` | WBTC token address | Yes | — |
| `ARBITRAGE_FUNDING` | `inventory` (pay from this signer's WBTC) or `router` (a treasury pays through an `ArbitrageRouter`) | No | `inventory` |
| `ARBITRAGE_ROUTER_ADDRESS` | The deployed `ArbitrageRouter`. Its immutable `signer`, `payer` and `wbtc` are read back and checked at boot | router | — |
| `ARBITRAGE_RELAY_DEADLINE_SECONDS` | How long a signed batch stays valid, in **chain** seconds. Bounded to 1–300: the router carries no nonce, so a signed batch is replayable by anyone until it expires, and the signature is public from the moment it is broadcast | No | `120` |
| `VAULT_KEEPER_ADDRESS` | Registered vault keeper the acquired vault is redeemed to. **Required** under `ARBITRAGE_FUNDING=router`, which only ever redeems on behalf of a keeper. Set it when the executor is **not** itself a keeper (e.g. a Safe): the bot pays and this keeper receives, via `swapWbtcForVaultOnBehalf`. Unset ⇒ the executor must be a keeper and pays for itself. Only point this at a keeper you control — the BTC lands there while the WBTC leaves the bot, so the legs only net out (and `RISK_MIN_PROFIT` only means anything) under one owner | No | — |
| `MAX_SLIPPAGE_BPS` | Maximum slippage tolerance (basis points) | No | `100` |
| `POLLING_INTERVAL_MS` | How often to check for vaults | No | `30000` |
| `VAULT_PROCESSING_DELAY_MS` | Throttle between acquisition broadcasts. Acquisitions are batched, so not a per-acquisition pause. `0` disables | No | `0` |
| `METRICS_PORT` | HTTP server port for metrics/health | No | `9091` |
| `METRICS_HOST` | Interface that server binds. Unset ⇒ every interface. `/metrics` is unauthenticated and labels carry the signer/treasury addresses and their balances, so restrict it where no network policy does | No | all interfaces |
| `EXECUTION_MODE` | `AUTO` signs and broadcasts; `MANUAL` persists proposals | No | `AUTO` |
| `MANUAL_EXECUTOR_ADDRESS` | Address the operator signs/broadcasts from; Safe address in `safe` custody | MANUAL only | — |
| `MANUAL_EXECUTOR_KIND` | Operator custody model: `eoa` or `safe` | MANUAL only | — |
| `MANUAL_INTENT_TTL_MS` | Expire un-actioned MANUAL proposals after this many ms; `0` disables expiry | No | `10800000` |
| `MANUAL_INTENT_STUCK_MS` | Alert on `claimed`/`submitted` MANUAL intents older than this; `0` disables | No | `3600000` |
| `SECRETS_PROVIDER` | Secret reference backend: `env` or `aws` Secrets Manager | No | `env` |
| `SIGNER_SOURCE` | AUTO signer backend: `local` or `aws` KMS | No | `local` |
| `SIGNER_KEY_REF` | Local signer secret reference; defaults to the service private-key env var | No | `ARBITRAGEUR_PRIVATE_KEY` |
| `KMS_KEY_ID` | AWS KMS key id/ARN/alias for `SIGNER_SOURCE=aws` | KMS only | — |
| `SIGNER_ADDRESS` | Expected signer address; boot fails if the key derives a different one. Applies to both `local` and `aws` — with the key behind a secret ref or a KMS id, the account it derives is invisible until something derives it | No | — |
| `AWS_REGION` | AWS region for KMS and Secrets Manager | No | — |
| `DATABASE_URL` | Enables Postgres StateStore for intent idempotency and reconcile-on-boot | MANUAL only | — |
| `PERSISTENCE_SCHEMA` | Schema for bot StateStore tables, separate from Ponder. **One schema per signer** — a schema is claimed by the first execution identity to use it and a second one fails at boot, because intents in it are keyed and reconciled as a single account. Running both services against one `DATABASE_URL` therefore needs a distinct value here for each. | No | `bot` |
| `NOTIFIER` | Notification backend: `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for Slack webhook URL | if `NOTIFIER=slack` | — |
| `ADAPTER_ADDRESS` | Enables the optional liquidation engine when set with `LENS_ADDRESS` | Liquidation only | — |
| `LENS_ADDRESS` | AaveAdapterLens for optional liquidation mode; requires `ADAPTER_ADDRESS` | Liquidation only | — |
| `LIQUIDATION_POLLING_INTERVAL_MS` | Poll interval for the optional liquidation engine | No | `12000` |
| `LIQUIDATION_FUNDING` | Funding mode for the optional liquidation engine: `inventory` or `flash`. `flash` requires the engine to be enabled | No | `inventory` |
| `LIQUIDATION_ROUTER_ADDRESS`, `FLASH_SWAP_VENUE_ADDRESS`, `FLASH_SWAP_POOLS`, `WBTC_FLASH_LOAN_ADDRESS` | Required together under `LIQUIDATION_FUNDING=flash`; see the [liquidator guide](./liquidator-operation-guide.md#53-liquidation-client-configuration) | flash | — |
| `WBTC_FLASH_LOAN_VENUE` | `morpho` or `aavev3` | No | `morpho` |
| `FLASH_MAX_SLIPPAGE_BPS` | How far realised profit may fall below the probe's quote before the chain reverts; derives the on-chain `minWbtcProfit`. Distinct from `RISK_MIN_PROFIT`, which is absolute and checked off-chain | No | `2000` |
| `RISK_MAX_CONSECUTIVE_FAILURES` | Auto-halt after this many consecutive failed actions | No | — |
| `RISK_MIN_PROFIT` | Profit floor in 8-decimal sats, applied to expected arbitrage profit. Rejected at boot when the optional liquidation engine is enabled **and inventory-funded**, since that path supplies no expected profit and the floor would cover only half the actions. Allowed when the engine is off or flash-funded. **Unset is not neutral** — see below | No | — |
| `RISK_MAX_IN_FLIGHT` | Max in-flight actions across both engines. Unset = no cap. Size above the largest cascade you want to compete in | No | unlimited |
| `RISK_MAX_DATA_STALENESS_MS` | Block actions whose indexer/source data is too old, missing, malformed, or dated in the future | No | — |
| `RISK_START_HALTED` | Boot HALTED until resumed; `true` requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | Pinned bytecode map: `address=keccak256(bytecode),...` — must name at least one contract when set, since an empty map would run the checker against nothing | No | — |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval for pinned bytecode | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference enabling authenticated `/halt`, `/resume`, `/status` | if `RISK_START_HALTED=true` | — |
| `RISK_CONTROL_PORT` | Kill-switch server port, separate from `METRICS_PORT` | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host; loopback by default | No | `127.0.0.1` |
| `RETRY_MAX_ATTEMPTS` | Max attempts per read, for both the indexer and the RPC transport | No | `3` |
| `RETRY_INITIAL_DELAY_MS` | Initial retry delay | No | `1000` |
| `RETRY_MAX_DELAY_MS` | Maximum retry delay | No | `30000` |
| `TX_RECEIPT_TIMEOUT_MS` | Transaction receipt timeout | No | `120000` |

#### What leaving `RISK_MIN_PROFIT` unset actually means

Not "the same behaviour without a floor". An acquisition is skipped only when the
on-chain preview says the vault is worth exactly nothing, and the number the
floor would have tested is not that preview — it is the **worst case the
transaction authorizes**: the vault's BTC minus `maxWbtcIn`, which carries the
whole `MAX_SLIPPAGE_BPS` buffer on top of the acquisition cost.

Those two can disagree. A vault previews profitably, the ceiling the bot signs
for sits above what the vault is worth, and the swap is free to charge anywhere
up to it. With no floor set, that acquisition is signed, and the size of the
worst case is bounded by `MAX_SLIPPAGE_BPS` and nothing else.

`RISK_MIN_PROFIT=0` is what makes the worst case non-negative. It is deliberately
not the default: a floor of zero is a policy, and a bot that quietly adopted one
would be making that choice for an operator who never stated it. Set it
explicitly if that is the policy you want.

### 5.4. Execution Modes

`EXECUTION_MODE=AUTO` is the default keeper mode: the process resolves one
signer, shares it across every engine this service runs, signs approvals and
actions, broadcasts them, and waits for receipts.

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

Off by default. `SUBMITTER=public` broadcasts to your node's mempool, which is
where searchers watch — a profitable liquidation is visible there before it
mines, and the mempool also advertises which positions you consider liquidatable
and at what threshold.

`SUBMITTER=flashbots-protect` submits privately instead. **AUTO only** — MANUAL is
keyless, so you broadcast with your own wallet and submission policy is yours;
the bot refuses the combination at startup rather than pretending to protect
transactions it never sends.

| Variable | Required | Notes |
|---|---|---|
| `SUBMITTER` | no | `public` (default) \| `flashbots-protect` |
| `FLASHBOTS_PROTECT_URL` | in private mode | e.g. `https://rpc.flashbots.net/fast` |
| `FLASHBOTS_STATUS_URL` | no | defaults to `https://protect.flashbots.net` |
| `PRIVATE_MIN_PRIORITY_FEE_WEI` | in private mode | no default, deliberately — see below |
| `PRIVATE_RELAY_HORIZON_BLOCKS` | no | default `25` — the relay's retry window, used when it states no deadline of its own; capped at `7200` (~a day of blocks) |
| `PRIVATE_RECLAIM_MARGIN_BLOCKS` | no | default `3` — reorg headroom past that deadline; same cap |

Four things fail the boot rather than degrading quietly, because each one
otherwise produces a bot that looks healthy and lands nothing:

- **`DATABASE_URL` is mandatory.** A privately-submitted transaction is invisible
  to your own node, so the persisted intents are the only thing that can tell
  whether a reserved nonce is still spoken for. Without them nothing fences it.
- **A priority-fee floor is mandatory.** Flashbots drops transactions builders
  have no reason to include. There is no sensible default: what is competitive is
  a market condition on the day, and guessing low fails silently.
  `PRIVATE_MIN_PRIORITY_FEE_WEI` is applied to every transaction the bot signs in
  private mode — the tip is raised to it when the node prices lower, and the fee
  cap rises with it. The node's own estimate is about being ordered ahead of the
  transactions it can see, which is not the market a private transaction is in.
- **Relay variables outside private submission are rejected** — under
  `SUBMITTER=public` and under `EXECUTION_MODE=MANUAL`, where the bot does not
  broadcast at all — so a half-applied configuration cannot leave you sending in
  public while believing otherwise.
- **The two block counts above are bounded.** They are the only things that ever
  release the nonce of a private transaction the relay has dropped, and a fence
  set to an implausible number is indistinguishable, from the outside, from a
  nonce that never comes back.

**The trade-off is yours to make, and it is real.** Private submission reduces
front-running, but it also narrows who can include you (Protect's default forwards
only to the Flashbots builder; `/fast` targets all registered builders) and aligns
submission to block boundaries. Whether that wins or loses more liquidations than
it saves depends on your competition and capital. Judge it from your own metrics,
not from this page:

| Metric | What it tells you |
|---|---|
| `submitter_send_total{result="accepted"}` | the relay is taking your transactions |
| `submitter_send_total{result="rejected"}` | the relay is *refusing* them — a malformed call or a bad fee |
| `submitter_send_total{result="ambiguous"}` | relay unreachable or 5xx; the nonce stays fenced |
| `relay_tx_status_total{status="INCLUDED"}` | they are landing |
| `relay_tx_status_total{status="sim_error"}` | **your** transactions are unviable, not out-competed — check the fee floor and the call |
| `relay_tx_status_total{status="probe_error"}` | the status API is unreachable; nonces stay fenced (safe, but throughput suffers) |

`accepted` climbing while `INCLUDED` stays flat is the signature of a fee floor
set too low, or of a builder fan-out too narrow.

**A stuck private nonce.** If a transaction is dropped by the relay and never
mined, its nonce is held until the chain passes that transaction's own deadline —
the `maxBlockNumber` the relay reported when it took it, recorded on the intent —
plus `PRIVATE_RECLAIM_MARGIN_BLOCKS`, and is then released automatically. Later
transactions queue behind it in the meantime, because nonces are consumed in
order. That is expected and self-healing.

The deadline is the relay's, not a duration you configure, so there is nothing to
tune per relay: `PRIVATE_RELAY_HORIZON_BLOCKS` only covers a transaction whose
status was never readable, and is never allowed to shorten a deadline the relay
did state. Blocks rather than elapsed time matters when the chain stalls — a wall
clock keeps running while a transaction the relay can still land goes nowhere.

What is *not* expected is the queue never draining: if `eth_getTransactionCount`
stops advancing while the bot keeps recording intents, raise the log level and
check for `Relay status probe failed` — a status endpoint that is persistently
unreachable keeps every nonce fenced until its horizon.

### 5.6. Contract Addresses

Testnet contract addresses are provided as part of the onboarding requirements.

| Contract | Purpose |
|----------|---------|
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap — `swapWbtcForVault()` and `previewEscrowedVaults()` |
| `WBTC_ADDRESS` | WBTC token for acquisition payments |

## 6. Wallet Setup

### 6.1. Funding Requirements

The arbitrageur wallet requires:

Under `ARBITRAGE_FUNDING=inventory` (the default), the arbitrageur wallet requires:

| Asset | Purpose | Notes |
|-------|---------|-------|
| **ETH** | Transaction gas | Monitor balance for continuous operation |
| **WBTC** | Vault acquisition payments | Must have sufficient balance to acquire vaults |

Under `ARBITRAGE_FUNDING=router` the WBTC moves to the treasury and this wallet needs **only ETH**.
The router pulls exactly the preview cost from the treasury and sweeps any residue straight back, so
the signing key can direct that allowance but can never receive it. What the treasury must hold:

| Asset | Held by | Notes |
|-------|---------|-------|
| **ETH** | the bot's signer | Gas only. It pays for the transaction, not the vault |
| **WBTC** | the treasury (`payer`) | Plus an allowance to the router — the bot cannot grant it, and boot fails without it |

**WBTC requirements:**
- Vaults are acquired at a discount (see [Economic Model](#101-economic-model) for details)
- Maintain buffer for multiple simultaneous acquisitions
- Monitor `arbitrageur_wbtc_balance` metric
- Under router funding, spendable capacity is `min(treasury balance, allowance)` — an allowance that
  runs down stops acquisitions just as surely as an empty treasury

**Recommended monitoring:**
- Set up alerts for low ETH balance
- Set up alerts for low WBTC balance — on `arbitrageur_funding_wbtc_balance`, which follows whichever
  account actually pays. `arbitrageur_wbtc_balance` is always the *signer's*, so under router funding
  it will sit flat while the treasury drains
- Under router funding, alert on `arbitrageur_funding_wbtc_allowance` too: an exhausted approval
  stops acquisitions exactly like an empty treasury, and only the treasury can raise it
- In MANUAL mode, monitor proposals with `operator-cli list` and Slack/log notifications

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
docker compose up -d arbitrageur-postgres arbitrageur-ponder arbitrageur-bot
```

**View logs:**

```bash
# All arbitrageur services
docker compose logs -f arbitrageur-ponder arbitrageur-bot

# Specific service
docker compose logs -f arbitrageur-bot
```

**Service dependencies:**
- `arbitrageur-postgres` must be healthy before `arbitrageur-ponder` starts
- `arbitrageur-ponder` must be healthy before `arbitrageur-bot` starts

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

The risk-control kill switch, when enabled, is not served from this port. It
listens on `RISK_CONTROL_HOST:RISK_CONTROL_PORT` and requires a bearer token.

**Key metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `eth_rpc_calls_total` | Counter | Outbound JSON-RPC attempts by `method` (retries counted separately) |
| `submitter_send_total` | Counter | Broadcast attempts by `result` (`accepted`/`rejected`/`ambiguous`) — private submission only; see §5.5 |
| `relay_tx_status_total` | Counter | Relay status by `status`, plus `sim_error` (our tx is unviable) and `probe_error` (relay unreachable) |
| `arbitrageur_vaults_acquired_total` | Counter | Total vaults acquired |
| `arbitrageur_wbtc_spent_total` | Counter | Total WBTC spent (satoshis) |
| `arbitrageur_wbtc_balance` | Gauge | Current WBTC balance (satoshis) |
| `arbitrageur_errors_total` | Counter | Errors by type |
| `arbitrageur_poll_duration_seconds` | Histogram | Poll cycle duration |
| `arbitrageur_last_poll_timestamp` | Gauge | Last poll timestamp |

If `ADAPTER_ADDRESS` and `LENS_ADDRESS` enable the optional liquidation engine,
the same endpoint also exposes the `liquidator_*` metric set.

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

### 8.3. Indexer Endpoints

**MANUAL proposals:**

```bash
# Proposals awaiting an operator
pnpm --filter @services/operator-cli operator-cli list --action vault-acquisition

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

**Query indexer endpoints:**

```bash
# Escrowed vaults available for acquisition (enriched with live debt data)
curl http://localhost:42070/escrowed-vaults

# Raw escrowed vaults (for debugging)
curl http://localhost:42070/escrowed-vaults-raw
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

The Hub debt on an escrowed vault accrues interest over time. The
contract function `BTCVaultSwap.previewEscrowedVaults(bytes32[])`
returns, for each vault, a tuple including:

| Field | Meaning |
|---|---|
| `amountVault` | Original BTC in the vault (sats) |
| `amountDebt` | Current Hub debt = principal + accrued interest |
| `amountInterest` | Interest accrued above the escrow-time principal |
| `amountFee` | Protocol fee (only set when profitable) |
| `amountWbtcToAcquire` | What the arbitrageur pays = `amountDebt + amountFee` |
| `isProfitable` | `true` iff vault BTC value (oracle) > `amountDebt` |

The Ponder API surfaces this as `currentDebt` (= `amountWbtcToAcquire`)
and `isProfitable`. Slippage is applied to `currentDebt`:
`maxWbtcIn = currentDebt + currentDebt * MAX_SLIPPAGE_BPS / 10000`.

> **Note**: Vault acquisition is first-come-first-served. The first successful
> `swapWbtcForVault()` transaction wins the vault.

### 9.1. Incident: the signing key is compromised (router funding)

Router funding shrinks the blast radius of a lost key — the router pulls only the preview cost from
the treasury and sweeps any residue straight back, so the key can never *receive* the float. It does
not eliminate it: `vaultSwap` is an argument to each signed call, so whoever holds the key can point
the router at a contract of their choosing and spend the entire allowance into it.

**The approval is the exposure, so revoke it first.** Do this before stopping the bot — the bot's
own submissions are not what is dangerous, and a stopped bot does nothing to stop an attacker:

```bash
cast send "$WBTC_ADDRESS" "approve(address,uint256)" "$ROUTER" 0 \
  --rpc-url "$RPC_URL" --private-key "$TREASURY_KEY"
```

Then, in order:

1. Halt the bot via the kill switch (`POST /halt`), or stop the process.
2. Deploy a **new** router for the new signer — see §4.4. `signer`, `payer` and `wbtc` are all
   immutable, so there is no rotation: the compromised router is retired, not repaired.
3. Point `ARBITRAGE_ROUTER_ADDRESS` at the new one and restart. Boot re-reads the router's
   immutables and refuses to start if they disagree with the bot's key.
4. Approve the new router from the treasury, with working capital rather than an unlimited amount.

Signed batches already in flight stay valid until their `ARBITRAGE_RELAY_DEADLINE_SECONDS` expires —
they carry no nonce and anyone may submit them — but revoking the approval makes them fail, which is
the second reason to revoke first.

The same key also signs liquidations. If the liquidation engine is enabled, treat
`LIQUIDATION_ROUTER_ADDRESS` as compromised too: its `owner` is this signer, and it sweeps proceeds
there.

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
| "EXECUTION_MODE=MANUAL requires DATABASE_URL" | MANUAL proposals need durable storage | Set `DATABASE_URL` and matching `PERSISTENCE_SCHEMA` |
| "EXECUTION_MODE=MANUAL is keyless" | A signer or private key is present in MANUAL | Unset signer env and the effective private-key env var |
| "halted (...)" | Risk gate is HALTED | `GET /status` and read `reason` — it is the only record of a halt raised while already HALTED; then `POST /resume` if appropriate (409 means the code-hash guard is holding it) |

### 10.2. Error Types

| Error Type | Trigger | Action |
|------------|---------|--------|
| `poll_error` | Exception escaped the poll cycle | Check logs for stack trace |
| `ponder_fetch_error` | Failed to fetch from indexer | Verify Ponder is running |
| `vault_skipped` | Vault no longer in escrow at preview time, or `isProfitable=false` | Normal skip — the indexer is one block behind reality, or the vault was already acquired |
| `risk_blocked` | Risk gate blocked an otherwise executable candidate | Check risk config and kill-switch state |
| `intent_in_flight` | Existing live intent/proposal already owns this vault | Let reconcile/operator workflow finish, or inspect the StateStore |
| `gas_estimation_failed` | `estimateContractGas` reverted | Contract would revert; usually transient |
| `swap_send_error` | Executor failed or aborted before a receipt wait | Check RPC, balance, approvals, or MANUAL proposal status |
| `tx_timeout` | Receipt wait exceeded `TX_RECEIPT_TIMEOUT_MS` | Check network, increase timeout |
| `swap_reverted` | Receipt status was `reverted` | Vault likely acquired by another |
| `contract_revert` | `writeContract` rejected with a contract revert | Check transaction for reason |
| `acquire_error` | Other unhandled exception during acquisition | Check WBTC balance, approval |

**Viewing logs:**

```bash
# Native
# Logs output to stdout

# Docker
docker compose logs -f arbitrageur-bot --tail 100
```
