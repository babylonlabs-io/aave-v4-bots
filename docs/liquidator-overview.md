# Aave v4 Vault Liquidation

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults allows BTC holders to borrow against their Bitcoin on Ethereum. When a borrower's position becomes undercollateralized (health factor < 1.0), it becomes eligible for liquidation. The liquidator repays the borrower's debt and seizes the collateral.

Only **full liquidations** are supported. Partial liquidation is not available for positions using BTC vaults as collateral.

## Permissionless Liquidation

Liquidating positions backed by BTC vaults is **fully permissionless**. Any address with sufficient debt tokens can call `liquidate()` on the Controller.

This design choice enables:

1. **Flash Loan Liquidations**: Liquidators can borrow debt tokens, execute liquidation, swap vaults for WBTC, repay the flash loan, and profit in a single transaction. No upfront capital required.

2. **MEV Searchers**: Automated systems can compete for liquidation opportunities without any onboarding.

3. **Protocol Health**: More liquidators means faster position cleanup and better protocol solvency.

## Key Contracts

**Aave Integration Controller**: Entry point for liquidations. Interacts with the Core Spoke to handle debt repayment and vault seizure.

**Swap Spoke**: Only pre-registered keepers can redeem BTC from vaults. The Swap Spoke enables liquidators to instantly swap seized vaults for WBTC without keeper registration.

## Liquidation Flow

```
Liquidator                    Controller                     Aave v4 / Swap Spoke
    │                              │                                │
    │ liquidate(proxyAddress) ────▶│                                │
    │                              │─── repay debt to Aave ────────▶│
    │                              │─── seize vault collateral ────▶│
    │◀──── vaults transferred ─────│                                │
    │                              │                                │
    │ swapVaultForWbtc(vaultId) ──▶│                                │
    │                              │─── transfer vault to escrow ──▶│
    │◀──── receive WBTC ───────────│◀─── borrow WBTC from Hub ──────│
```

### Step by Step

1. **Identify Target**: Find positions where `healthFactor < 1.0` and `totalDebtValue > 0`

2. **Execute Liquidation**: Call `liquidate` on the Aave Integration Controller. The liquidator repays the debt and receives ownership of the BTC vaults worth more than the debt repaid (liquidation bonus).

3. **Instant Exit** (Optional): Call `swapVaultForWbtc` on the Swap Spoke to exchange vault ownership for WBTC immediately. The vault enters escrow for arbitrageurs to acquire.

## Vault Ownership Options

After liquidation, the liquidator owns the seized BTC vaults. Two paths forward:

| Path | Description |
|------|-------------|
| **Swap for WBTC** | Instant liquidity via Swap Spoke |
| **Open a position** | Use the vault as collateral to borrow against it |

> **Note**: Only registered keepers can redeem vaults for actual BTC. If the liquidator is not a registered keeper, redemption is not available.

## Liquidation Bot

The liquidation bot automates position monitoring and liquidation execution.

### Architecture

![Liquidator Bot Architecture](./assets/liquidatorArchitecture.png)

### Components

**Ponder Indexer**: Indexes `Supply`, `Withdraw`, and `LiquidationCall` events from the Core Spoke contract. Tracks all active positions with collateral.

**Liquidation Bot**: Polls the indexer for liquidatable positions and executes liquidations.

### Bot Operation

1. **Poll**: Query `/liquidatable-positions` from Ponder indexer at configured interval

2. **Filter**: Indexer returns positions where `healthFactor < 1e18` (< 1.0) and `totalDebtValue > 0`

3. **Approve**: Ensure debt token approval for Controller (one-time setup)

4. **Liquidate**: Call `liquidate` for each eligible position

5. **Swap** (Optional): Call `swapVaultForWbtc` to convert seized vaults to WBTC

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LIQUIDATOR_PRIVATE_KEY` | Private key of liquidator wallet | Required |
| `RPC_URL` | Ethereum RPC endpoint | Required |
| `CONTROLLER_ADDRESS` | AaveIntegrationController contract | Required |
| `DEBT_TOKEN_ADDRESS` | Debt token contract (e.g., USDC) | Required |
| `POLLING_INTERVAL_MS` | Position check frequency | 10000 (10s) |

### Requirements

- **Debt Tokens**: Sufficient balance to repay positions (unless using flash loans)
- **ETH**: For transaction gas
- **Infrastructure**: Reliable RPC access

## Contract Interfaces

### Controller (liquidation functions)

```solidity
// Liquidate an undercollateralized position
function liquidate(address borrowerProxy) external returns (uint256 seizedAmount, uint256 repaidAmount);

// Get vault owner
function getVaultOwner(bytes32 vaultId) external view returns (address);
```

### Swap Spoke (instant exit functions)

```solidity
// Swap vault ownership for WBTC
function swapVaultForWbtc(bytes32 vaultId) external returns (uint256 wbtcReceived);

// Preview WBTC amount for a vault
function previewVaultToWbtc(bytes32 vaultId) external view returns (uint256);
```

### Spoke (position data)

```solidity
// Get account health data
function getUserAccountData(address user) external view returns (
    uint256 totalCollateralValue,
    uint256 totalDebtValue,
    uint256 availableBorrowsValue,
    uint256 currentLiquidationThreshold,
    uint256 ltv,
    uint256 healthFactor
);
```

### Events

```solidity
// Emitted on liquidation
event BTCVaultCoreSpokeLiquidated(
    address indexed borrowerProxy,
    address indexed liquidator,
    address depositor,
    uint256 debtRepaid,
    uint256 seizedAmount
);

// Emitted when liquidator swaps vault for WBTC
event VaultSwappedForWbtc(
    address indexed seller,
    bytes32 vaultId,
    uint256 wbtcAmount
);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | Calls `liquidate()`, repays debt | Receives BTC vault ownership |
| **Liquidator** | Calls `swapVaultForWbtc()` | Receives instant WBTC, vault goes to escrow |
| **Swap Spoke** | Holds vault in escrow | Bridges liquidator exit to arbitrageur entry |

Liquidation is permissionless. Flash loans enable zero-capital liquidation strategies. Instant WBTC swap eliminates capital lock and registration requirements.

