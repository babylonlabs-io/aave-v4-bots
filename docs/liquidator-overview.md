# Aave v4 Liquidation

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults protocol allows BTC holders to trustlessly use their BTC as collateral to borrow on Ethereum. When a borrower's position becomes undercollateralized (health factor < 1.0), it becomes eligible for liquidation. The liquidator repays the borrower's debt and seizes the collateral.

The Bitcoin contained in a trustless BTC vault cannot be split on the BTC side, but the Aave-side liquidation logic can still liquidate only part of a position's collateral shares in a given call. In practice, a position may be liquidated incrementally across multiple events until its tracked shares reach zero.

## Permissionless Liquidation

Liquidating positions backed by BTC vaults is fully permissionless. Any address with sufficient debt tokens can call `liquidateCorePosition()` on the Controller.

This design choice enables:

- **Flash Loan Liquidations**: Liquidators can borrow debt tokens, execute liquidation (which atomically swaps vaults for WBTC when `btcRedeemKey = bytes32(0)`), repay the flash loan, and profit in a single transaction. No upfront capital required.
- **MEV Searchers**: Automated systems can compete for liquidation opportunities without any onboarding.
- **Protocol Health**: More liquidators means faster position cleanup and better protocol solvency.

## Accessing Vault Contents

While liquidation is permissionless, accessing the underlying collateral is subject to the following constraints:

- **Restricted Claimer Set**: The entities that can withdraw Bitcoin from the BTC vault must be defined at the time of the vault's creation, as they need to pre-sign a set of Bitcoin transactions associated with it.
- **Delayed Withdrawal**: BTC Vault contents are not released immediately; they require a challenge period of 2-3 days before the withdrawal is finalized.

Consequently, while anyone can trigger a liquidation, only authorized entities can claim the vault's contents. To preserve the spirit of permissionless liquidations, the architecture allows these authorized claimers to "buy" liquidated vaults from public liquidators at a discount. This mechanism fosters a thriving liquidator ecosystem despite the underlying withdrawal limitations.

## Key Contracts

- **Aave Integration Controller**: Entry point for liquidations. Interacts with the Core Spoke to handle debt repayment and vault seizure. When `btcRedeemKey = bytes32(0)`, atomically swaps seized vaults for WBTC via VaultSwap.
- **Aave Integration Lens**: Read-only contract that pre-computes the exact `TokenAmount[]` inputs needed for a liquidation (debt repayments, fairness payment, protocol fee).
- **VaultSwap**: Only pre-registered keepers can redeem BTC from vaults. The VaultSwap contract enables liquidators to instantly receive WBTC without keeper registration (called atomically by the Controller).

## Liquidation Flow

<!-- TODO: Add architecture diagram (liquidatorArchitecture.png) -->

```
Liquidator                    Lens                Controller                  VaultSwap
    │                           │                      │                          │
    │ estimateLiquidation() ───▶│                      │                          │
    │◀─── inputs[], vaults[] ───│                      │                          │
    │                           │                      │                          │
    │ liquidateCorePosition(borrower, redeemKey, inputs) ──▶│                     │
    │                           │                      │── repay debt to Aave ───▶│
    │                           │                      │── seize vaults ─────────▶│
    │                           │                      │── swap vaults for WBTC ─▶│ (if redeemKey=0)
    │◀────────── WBTC received ────────────────────────│◀── WBTC ────────────────│
```

### Step by Step

1. **Identify Target**: Find positions where `healthFactor < 1.0` and `totalDebtValue > 0`
2. **Estimate Inputs**: Call `estimateLiquidation(proxyAddress)` on the Lens to get the exact `TokenAmount[]` inputs needed
3. **Execute Liquidation**: Call `liquidateCorePosition(borrower, btcRedeemKey, inputs)` on the Controller. The liquidator repays the debt and receives WBTC (when `btcRedeemKey = bytes32(0)`, the Controller atomically swaps seized vaults for WBTC via VaultSwap)

### Redemption Modes

| Mode | `btcRedeemKey` | Result |
|------|----------------|--------|
| **WBTC payout** (default) | `bytes32(0)` | Controller atomically swaps vaults for WBTC via VaultSwap |
| **Direct BTC redemption** | Non-zero key | Vaults redeemed directly to BTC address (requires vault keeper status) |

> **Note**: Most liquidators will use the default WBTC payout mode. Direct BTC redemption requires pre-registration as a vault keeper.

## Liquidation Bot

The liquidation bot automates position monitoring and liquidation execution.

### Architecture

![Liquidator Bot Architecture](./assets/liquidationArchitecture.png)

### Components

- **Ponder Indexer**: Indexes `Supply`, `Withdraw`, `LiquidationCall`, and `UserProxyCreated` events. Tracks all active positions and proxy-to-borrower mappings.
- **Liquidation Bot**: Polls the indexer for liquidatable positions and executes liquidations.

### Bot Operation

1. **Poll**: Query `/liquidatable-positions` from Ponder indexer at configured interval
2. **Filter**: Indexer returns positions where `healthFactor < 1e18` (< 1.0) and `totalDebtValue > 0`, including the borrower EOA address
3. **Estimate**: Call `estimateLiquidation(proxyAddress)` on the Lens to compute exact inputs for each position
4. **Simulate**: Simulate all liquidations in parallel to filter to valid ones
5. **Approve**: Ensure debt token approval for Controller (one-time setup)
6. **Liquidate**: Call `liquidateCorePosition(borrower, btcRedeemKey, inputs)` for each eligible position with explicit nonces

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LIQUIDATOR_PRIVATE_KEY` | Private key of liquidator wallet | Required |
| `CLIENT_RPC_URL` | Ethereum RPC endpoint | Required |
| `PONDER_URL` | Ponder indexer API URL | Required |
| `CONTROLLER_ADDRESS` | AaveIntegrationController contract | Required |
| `LENS_ADDRESS` | AaveIntegrationLens contract | Required |
| `WBTC_ADDRESS` | WBTC token address | Required |
| `DEBT_TOKEN_ADDRESSES` | Debt token addresses (comma-separated, optional) | Auto-discovered |
| `BTC_REDEEM_KEY` | BTC redeem key for direct redemption (`bytes32(0)` = WBTC payout) | `bytes32(0)` |
| `POLLING_INTERVAL_MS` | Position check frequency | `10000` (10s) |
| `METRICS_PORT` | Prometheus metrics port | `9090` |

### Requirements

- **Debt Tokens**: Sufficient balance to repay positions (unless using flash loans)
- **ETH**: For transaction gas
- **Infrastructure**: Reliable RPC access

## Contract Interfaces

### Lens (pre-computation)

```solidity
// Estimate liquidation inputs for a position
function estimateLiquidation(address borrowerProxy)
    external view returns (TokenAmount[] memory inputs, bytes32[] memory vaults);

// Estimate with custom reserve priority ordering
function estimateLiquidationWithPriority(
    address borrowerProxy,
    uint256[] memory priorityLoanTokenIds
) external view returns (TokenAmount[] memory inputs, bytes32[] memory vaults);
```

### Controller (liquidation functions)

```solidity
// Liquidate an undercollateralized position
// When btcRedeemKey = bytes32(0), atomically swaps vaults for WBTC
function liquidateCorePosition(
    address borrower,
    bytes32 btcRedeemKey,
    TokenAmount[] memory inputs
) external returns (uint256 seizedAmount);

// Get borrower EOA for a proxy address
function getUserOfProxy(address proxy) external view returns (address);
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
// Emitted when a user proxy is created
event UserProxyCreated(address indexed user, address indexed proxy);

// Emitted on liquidation
event BTCVaultCoreSpokeLiquidated(
    address indexed borrowerProxy,
    address indexed liquidator,
    address depositor,
    uint256 debtRepaid,
    uint256 seizedAmount
);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | Calls `estimateLiquidation()` on Lens | Gets exact inputs (debt repayments + fees) |
| **Liquidator** | Calls `liquidateCorePosition(borrower, redeemKey, inputs)` | Repays debt, receives WBTC atomically (when `redeemKey = bytes32(0)`) |
| **Controller** | Executes liquidation + atomic WBTC swap | Seizes vaults, swaps via VaultSwap, sends WBTC to liquidator |

Liquidation is permissionless. Flash loans enable zero-capital liquidation strategies. Atomic WBTC payout eliminates multi-step complexity and capital lock.
