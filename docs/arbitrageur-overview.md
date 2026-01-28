# Aave v4 Vault Arbitrageurs

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults enables BTC holders to use their Bitcoin as collateral for borrowing on Ethereum. When borrowers become undercollateralized, their positions can be liquidated. However, liquidating BTC vault collateral presents unique challenges that the **Swap Spoke** and **arbitrageur system** are designed to solve.

## The Problem

Liquidations in Aave v4 are permissionless, anyone can liquidate an undercollateralized position. However, redeeming the underlying BTC from a vault requires:

1. **Registered Application Keepers**: Only pre-registered entities can initiate vault redemption through the protocol
2. **Multi-day Settlement Delay**: BTC redemption involves a challenge period of approximately three days, making flash loan liquidations impossible

These constraints mean permissionless liquidators cannot directly receive BTC. They need immediate liquidity to continue operating.

## The Solution: Swap Spoke

Aave v4 uses a Hub and Spoke architecture where the Hub manages core lending logic and Spokes handle asset-specific operations. The **Swap Spoke** is a custom spoke designed specifically for BTC vault collateral, enabling instant liquidity for liquidators while preserving the security model of the Babylon vault protocol.

### How It Works

![Liquidation Flow](./assets/liquidationFlow.png)

### Liquidation Flow

1. **Liquidation**: A permissionless liquidator identifies an undercollateralized position and executes liquidation on Aave v4, receiving ownership of the BTC vault(s)

2. **Instant Swap**: The liquidator calls `swapVaultForWbtc` on the Swap Spoke, transferring vault ownership to escrow and receiving WBTC immediately. The WBTC is provided by the Aave Hub as a loan.

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

The debt on an escrowed vault accrues interest over time. The function `previewWbtcToAcquireVault(vaultId)` returns the current amount needed to acquire a vault, including accrued interest. This means:

- Arbitrageurs are incentivized to acquire vaults quickly
- Waiting too long reduces the profit margin
- Multiple arbitrageurs may compete for the same vault

## Arbitrageur Bot

The arbitrageur bot automates the process of monitoring and acquiring escrowed vaults.

### Architecture

![Arbitrageur Bot Architecture](./assets/arbitrageurArchitecture.png)

### Bot Operation

1. **Polling**: The bot periodically queries the Ponder indexer for available escrowed vaults

2. **Evaluation**: For each vault, the bot retrieves the current debt (principal + interest) via `previewWbtcToAcquireVault`

3. **Execution**: If the vault is profitable, the bot:
   - Ensures WBTC approval for the VaultSwap contract
   - Calls `swapWbtcForVault` with the vault ID and maximum WBTC willing to pay
   - Waits for transaction confirmation

4. **Tracking**: Successfully acquired vaults are tracked locally for later redemption

### Configuration

| Parameter | Description |
|-----------|-------------|
| `POLLING_INTERVAL_MS` | How often to check for new vaults (default: 30s) |
| `MAX_SLIPPAGE_BPS` | Maximum slippage tolerance in basis points |
| `AUTO_REDEEM` | Whether to automatically initiate redemption after acquisition |

### Requirements

To run an arbitrageur bot, you need:

- **Registration**: Partnership agreement with the protocol for keeper registration
- **WBTC Capital**: Sufficient WBTC to front vault acquisitions
- **Infrastructure**: Reliable RPC access and monitoring

## Contract Interfaces

### Swap Spoke (read functions)

```solidity
// Get all currently escrowed vault IDs
function getEscrowedVaults() external view returns (bytes32[] memory);

// Check if a specific vault is in escrow
function isVaultEscrowed(bytes32 vaultId) external view returns (bool);

// Get WBTC needed to acquire a vault (includes accrued interest)
function previewWbtcToAcquireVault(bytes32 vaultId) external view returns (uint256);
```

### VaultSwap (arbitrageur functions)

```solidity
// Acquire vault ownership by paying WBTC
function swapWbtcForVault(bytes32 vaultId, uint256 maxWbtcIn) external returns (uint256 wbtcPaid);
```

### Controller (ownership functions)

```solidity
// Get current owner of a vault
function getVaultOwner(bytes32 vaultId) external view returns (address);
```

### Events

```solidity
// Emitted when a vault is escrowed (liquidator swaps vault for WBTC)
event VaultSwappedForWbtc(address indexed seller, bytes32 vaultId, uint256 wbtcAmount);

// Emitted when an arbitrageur acquires a vault
event WbtcSwappedForVault(address indexed buyer, bytes32 vaultId, uint256 wbtcAmount);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | Liquidates position, swaps vault for WBTC | Receives instant WBTC liquidity |
| **Swap Spoke** | Holds vault in escrow, borrows from Hub | Bridges permissionless liquidation to registered redemption |
| **Arbitrageur** | Monitors and acquires escrowed vaults | Pays discounted price, gains vault ownership |
| **Aave Hub** | Provides WBTC liquidity | Loan repaid when arbitrageur acquires |

