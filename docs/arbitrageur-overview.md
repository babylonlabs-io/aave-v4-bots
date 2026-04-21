# Aave v4 Vault Arbitrageurs

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults enables BTC holders to use their Bitcoin as collateral for borrowing on Ethereum. When borrowers become undercollateralized, their positions can be liquidated. However, liquidating BTC vault collateral presents unique challenges that the **VaultSwap** and **arbitrageur system** are designed to solve.

## The Problem

Liquidations in Aave v4 are permissionless, anyone can liquidate an undercollateralized position. However, redeeming the underlying BTC from a vault requires:

1. **Registered Application Keepers**: Only pre-registered entities can initiate vault redemption through the protocol
2. **Multi-day Settlement Delay**: BTC redemption involves a challenge period of approximately three days, making flash loan liquidations impossible

These constraints mean permissionless liquidators cannot directly receive BTC. They need immediate liquidity to continue operating.

## The Solution: VaultSwap

Aave v4 uses a Hub and Spoke architecture where the Hub manages core lending logic and Spokes handle asset-specific operations. **VaultSwap** provides instant liquidity for liquidators while preserving the security model of the Babylon vault protocol.

### How It Works

![Liquidation Flow](./assets/liquidationFlow.png)

### Liquidation Flow

1. **Liquidation**: A permissionless liquidator identifies an undercollateralized position and executes liquidation on Aave v4, receiving ownership of the BTC vault(s)

2. **Instant Swap**: The liquidator swaps seized vaults via `VaultSwap` and receives WBTC immediately. The WBTC is provided by the Aave Hub as a loan.

3. **Escrow State**: The vault is now held in escrow, waiting to be acquired by a registered arbitrageur. If a position contained multiple vaults, each is escrowed individually.

## Arbitrageur Role

Arbitrageurs are **pre-registered Aave v4 application keepers** who have the exclusive right to purchase escrowed vaults. Registration is handled through partnership agreements with the protocol.

### Why Registration Is Required

- Only registered keepers can later redeem vaults for actual BTC through the Babylon protocol
- This ensures arbitrageurs can realize their profit by completing the redemption flow
- Registration involves off-chain setup for the vault keeper infrastructure

### Arbitrageur Economics

When acquiring a vault, arbitrageurs pay less than the full BTC value. For example:

| Component | Example (1 BTC vault) |
|-----------|----------------------|
| Vault BTC Value | 1.00 BTC |
| Arbitrageur Pays | ~0.97 WBTC |
| **Gross Profit** | **~0.03 BTC** |

> **Note**: The exact discount percentage is not yet finalized and will be defined as a fixed protocol parameter before mainnet launch.

The WBTC payment is distributed as follows:
- **Loan Repayment**: Repays the WBTC borrowed from Aave Hub when the liquidator swapped
- **Protocol Fees**: Split between Babylon Labs and Aave v4 as liquidation fees

### Interest Accrual

The debt on an escrowed vault accrues interest over time. The function `previewWbtcToAcquireVaultWithFees(vaultId)` returns the current amount needed to acquire a vault, including principal, interest, and protocol fees. This means:

- Arbitrageurs are incentivized to acquire vaults quickly
- Waiting too long reduces the profit margin
- Multiple arbitrageurs may compete for the same vault

## Arbitrageur Bot

The arbitrageur bot automates the process of monitoring and acquiring escrowed vaults.

### Architecture

![Arbitrageur Bot Architecture](./assets/arbitrageurArchitecture.png)

### Bot Operation

1. **Polling**: The bot periodically queries the Ponder indexer for available escrowed vaults

2. **Evaluation**: For each vault, the bot retrieves the current debt (principal + interest + fees) via the indexer's enriched API

3. **Execution**: If the vault is profitable, the bot:
   - Ensures WBTC approval for the VaultSwap contract
   - Calls `swapWbtcForVault` with the vault ID and maximum WBTC willing to pay
   - Waits for transaction confirmation (acquisition and redemption are atomic)

### Configuration

| Parameter | Description |
|-----------|-------------|
| `POLLING_INTERVAL_MS` | How often to check for new vaults (default: 30s) |
| `MAX_SLIPPAGE_BPS` | Maximum slippage tolerance in basis points |

### Requirements

To run an arbitrageur bot, you need:

- **Registration**: Partnership agreement with the protocol for keeper registration
- **WBTC Capital**: Sufficient WBTC to front vault acquisitions
- **Infrastructure**: Reliable RPC access and monitoring

## Contract Interfaces

### VaultSwap (view functions)

```solidity
// Check if a specific vault is in escrow
function isVaultEscrowed(bytes32 vaultId) external view returns (bool);

// Get detailed cost breakdown for acquiring a vault (includes accrued interest)
function previewWbtcToAcquireVaultWithFees(bytes32 vaultId) external view returns (uint256 wbtcNeeded, uint256 principal, uint256 interest, uint256 protocolFee);

// Check if a vault is profitable for arbitrageurs
function isVaultProfitableForArbitrageur(bytes32 vaultId) external view returns (bool isProfitable, uint256 accruedInterest, uint256 arbitrageurDiscount, uint256 hubDebt);

// Get info for multiple escrowed vaults
function getEscrowedVaultsInfo(bytes32[] calldata vaultIds) external view returns (EscrowedVaultInfo[] memory);
```

### VaultSwap (arbitrageur functions)

```solidity
// Acquire vault ownership by paying WBTC (redemption is atomic)
function swapWbtcForVault(bytes32 vaultId, uint256 maxWbtcIn) external returns (uint256 amountWbtcIn);

// Emergency repay a vault's debt to release it from escrow
function emergencyRepayVault(bytes32 vaultId) external returns (uint256 wbtcRepaid);
```

### Events

```solidity
// Emitted when a vault is added to escrow (available for acquisition)
event AddedVault(bytes32 indexed vaultId);

// Emitted when a vault is removed from escrow (acquired or emergency repaid)
event RemovedVault(bytes32 indexed vaultId);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | Liquidates position, swaps vault for WBTC | Receives instant WBTC liquidity |
| **VaultSwap** | Holds vault in escrow, borrows from Hub | Bridges permissionless liquidation to registered redemption |
| **Arbitrageur** | Monitors and acquires escrowed vaults | Pays discounted price, vault is atomically redeemed |
| **Aave Hub** | Provides WBTC liquidity | Loan repaid when arbitrageur acquires |
