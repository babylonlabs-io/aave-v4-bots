# Aave v4 Liquidation

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults protocol
allows BTC holders to use their BTC as collateral to borrow on Ethereum.
When a borrower's position becomes undercollateralized (health factor <
1.0), it becomes eligible for liquidation. The liquidator repays the
borrower's debt and seizes the collateral.

The Bitcoin contained in a trustless BTC vault cannot be split on the BTC
side, but the Aave-side liquidation logic can still liquidate only part
of a position's collateral shares in a given call. In practice, a
position may be liquidated incrementally across multiple events until
its tracked shares reach zero.

## Permissionless Liquidation

Any address with sufficient debt tokens can call one of two functions on
the `AaveAdapter` contract to liquidate an undercollateralized position:

- `liquidate(borrower, btcRedeemKey, amounts, priorityOrder, minVaultBtcOut, numVaultsToLiquidate)` —
  direct redemption. The seized vaults are redeemed in the same
  transaction to the BTC key supplied in `btcRedeemKey`. Suits
  liquidators that hold a registered BTC keeper key. `minVaultBtcOut`
  reverts the call if the total BTC across seized vaults falls below
  the bound; `numVaultsToLiquidate` caps how many ordered vaults can
  be seized (use `type(uint256).max` for unbounded). Any vaultBTC
  remaining after the cap is returned to the borrower as collateral.
- `liquidateWithLLP(borrower, llp, amounts, priorityOrder, requestedTokens)` —
  LLP-mediated. The seized vault is transferred to a Liquidation
  Liquidity Provider (in this integration: BTCVaultSwap). The LLP draws
  WBTC from the Aave Hub at a sell discount and pays it to the
  liquidator immediately, leaving the vault escrowed for an arbitrageur
  to acquire later.

This dual path is what makes liquidation permissionless even though
redeeming a BTC vault is not. Liquidators who are not registered BTC
keepers use the LLP path, get WBTC right away, and let the arbitrageur
handle the eventual BTC redemption.

## Accessing Vault Contents

While liquidation is permissionless, redeeming the underlying BTC is
subject to:

- **Restricted Claimer Set** — the entities that can withdraw Bitcoin
  from a BTC vault are defined at vault creation, since they pre-sign a
  set of Bitcoin transactions.
- **Delayed Withdrawal** — BTC vault contents go through a challenge
  period (2-3 days) before redemption finalizes.

This is why the LLP path exists: liquidators receive instant WBTC
liquidity (at a discount) without needing keeper status, and registered
arbitrageurs handle the eventual redemption.

## Key Contracts

- **AaveAdapter** — entry point for liquidations. Calls into the Core
  Spoke to repay debt and seize collateral. Routes the seized vault
  either to direct redemption or to an LLP based on which liquidation
  function was called.
- **AaveAdapterLens** — read-only contract that pre-computes the
  `(amounts, wbtcPayment, vaults)` inputs needed for a liquidation
  call. `wbtcPayment` is the WBTC the adapter pulls from `msg.sender`
  for the fairness top-up and, in direct mode, the redemption fee.
- **BTCVaultSwap** — the LLP. Pays the liquidator WBTC at a sell
  discount when called by the adapter, holds the vault in escrow, and
  later accepts WBTC from a registered arbitrageur to release the
  vault.

## Liquidation Flow

```
Liquidator              Lens                AaveAdapter              Spoke / LLP
    │                     │                       │                       │
    │ estimateLiquidation()                                                │
    │ ─────────────────▶                                                   │
    │ ◀── amounts[], wbtcPayment, vaults[]                                 │
    │                                                                      │
    │ liquidate(...) OR liquidateWithLLP(...)                              │
    │ ─────────────────────────────────▶                                   │
    │                                       │── repay debt + seize ──────▶│ (Spoke)
    │                                       │                              │
    │            direct mode:                                              │
    │            vault redeemed to BTC_REDEEM_KEY in same tx               │
    │                                                                      │
    │            LLP mode:                                                 │
    │            vault → BTCVaultSwap; Hub draws WBTC at sell discount,    │
    │            liquidator receives WBTC; arbitrageur later acquires.     │
    │                                                                      │
    │ ◀────────────────── tx receipt ──────────────────────────────────────│
```

### Step by Step

1. **Identify Target** — find positions for which
   `Lens.estimateLiquidation(proxyAddress, isDirectRedemption)` returns
   without reverting (the Lens reverts on healthy positions). The
   indexer pre-filters by calling the Lens with `isDirectRedemption=false`;
   the bot re-estimates with its own mode before broadcast.
2. **Estimate Inputs** — the Lens returns
   `(uint256[] amounts, uint256 wbtcPayment, bytes32[] vaults)`.
   The bot inflates each amount by 1% to absorb interest accrual between
   the read and the broadcast. `wbtcPayment` is pulled from `msg.sender`
   by the adapter during liquidation, so the bot only needs sufficient
   WBTC balance and approval — the value itself is not threaded into
   the call.
3. **Simulate** — every candidate is simulated against the adapter; any
   that revert are dropped.
4. **Execute** — based on `IS_DIRECT_REDEMPTION` config, the bot calls
   either `liquidate(borrower, BTC_REDEEM_KEY, amounts, priorityOrder, 0, type(uint256).max)`
   or `liquidateWithLLP(borrower, LLP_ADDRESS, amounts, priorityOrder, [])`.
   `priorityOrder` is always `[0, 1, …, n-1]`. The bot passes `0` for
   `minVaultBtcOut` (simulation catches bad liquidations) and
   `type(uint256).max` for `numVaultsToLiquidate` (unbounded prefix).
   The empty `requestedTokens` array on the LLP path means the
   liquidator does not constrain the payout token.

### Redemption Modes

| Mode | Adapter function | Vault destination | Liquidator receives |
|------|------------------|-------------------|---------------------|
| Direct redemption | `liquidate` | Redeemed to `btcRedeemKey` in same tx | BTC (off-chain, after BTC settlement) |
| LLP escrow (default) | `liquidateWithLLP` | Escrowed in BTCVaultSwap | WBTC immediately (at sell discount) |

> **Note**: Direct mode requires `BTC_REDEEM_KEY` to point at a
> registered keeper key; the Adapter rejects `bytes32(0)`. LLP mode
> requires `LLP_ADDRESS` to be the BTCVaultSwap deployment; the Adapter
> rejects `address(0)`.

## Liquidation Bot

The bot automates monitoring and execution.

### Components

- **Ponder Indexer** — indexes Spoke events (`Supply`, `Withdraw`,
  `LiquidationCall`) and the Adapter event (`UserProxyCreated`).
  Tracks active positions and the proxy → borrower mapping.
- **Liquidation Client** — polls the indexer's
  `/liquidatable-positions` endpoint and executes liquidations.

### Bot Operation

1. **Discover debt tokens** — at boot, either reads
   `DEBT_TOKEN_ADDRESSES` or enumerates Spoke reserves and selects
   those flagged borrowable.
2. **Approve** — once at boot, sets `MAX_UINT256` allowance on every
   debt token and on WBTC for the AaveAdapter. WBTC approval is
   required because the adapter pulls the fairness payment and, in
   direct mode, the redemption fee directly from `msg.sender`.
3. **Poll** — fetches `/liquidatable-positions` from Ponder every
   `POLLING_INTERVAL_MS`.
4. **Estimate** — calls
   `AaveAdapterLens.estimateLiquidation(proxy, isDirectRedemption)` per
   candidate; bumps each amount by 1%.
5. **Simulate** — simulates every candidate against the Adapter; drops
   reverts.
6. **Liquidate** — calls `liquidate` or `liquidateWithLLP` based on
   `IS_DIRECT_REDEMPTION`, with sequential nonces.

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LIQUIDATOR_PRIVATE_KEY` | Private key of liquidator wallet | Required |
| `CLIENT_RPC_URL` | Ethereum RPC endpoint | Required |
| `PONDER_URL` | Ponder indexer API URL | Required |
| `ADAPTER_ADDRESS` | AaveAdapter address | Required |
| `LENS_ADDRESS` | AaveAdapterLens address | Required |
| `WBTC_ADDRESS` | WBTC token address | Required |
| `DEBT_TOKEN_ADDRESSES` | Comma-separated; auto-discovered if unset | Auto-discovered |
| `IS_DIRECT_REDEMPTION` | `true` calls `liquidate`; otherwise calls `liquidateWithLLP` | `false` |
| `BTC_REDEEM_KEY` | BTC key for direct mode (must be non-zero) | `bytes32(0)` |
| `LLP_ADDRESS` | LLP (BTCVaultSwap) address for LLP mode (must be non-zero) | `address(0)` |
| `POLLING_INTERVAL_MS` | Position check frequency | `10000` |
| `TX_RECEIPT_TIMEOUT_MS` | Receipt wait timeout | `120000` |
| `METRICS_PORT` | Prometheus metrics port | `9090` |

### Requirements

- **Debt Tokens** — sufficient balance to repay positions (unless using
  flash loans).
- **ETH** — for transaction gas.
- **Infrastructure** — reliable RPC access.

## Contract Interfaces

### AaveAdapterLens

```solidity
// Estimate liquidation for a position.
// `wbtcPayment` is the WBTC the adapter pulls from msg.sender for the
// fairness top-up and (direct mode) the redemption fee.
function estimateLiquidation(address borrowerProxy, bool isDirectRedemption)
    external
    view
    returns (uint256[] memory amounts, uint256 wbtcPayment, bytes32[] memory vaults);

// Estimate with custom reserve priority ordering
function estimateLiquidationWithPriority(
    address borrowerProxy,
    uint256[] memory priorityLoanTokenIds,
    bool isDirectRedemption
) external view returns (uint256[] memory amounts, uint256 wbtcPayment, bytes32[] memory vaults);
```

### AaveAdapter

```solidity
// Direct-redemption path. Requires btcRedeemKey != bytes32(0).
// `minVaultBtcOut` bounds the minimum total BTC across seized vaults
// (use 0 to disable). `numVaultsToLiquidate` caps the seized prefix
// (use type(uint256).max for unbounded).
function liquidate(
    address borrower,
    bytes32 btcRedeemKey,
    uint256[] memory amounts,
    uint256[] memory priorityOrder,
    uint256 minVaultBtcOut,
    uint256 numVaultsToLiquidate
) external;

// LLP-mediated path. Requires llp != address(0).
function liquidateWithLLP(
    address borrower,
    address llp,
    uint256[] memory amounts,
    uint256[] memory priorityOrder,
    TokenAmount[] memory requestedTokens
) external;
```

### Spoke

```solidity
// Account state used to determine health
struct UserAccountData {
    uint256 riskPremium;
    uint256 avgCollateralFactor;
    uint256 healthFactor;
    uint256 totalCollateralValue;
    uint256 totalDebtValueRay;
    uint256 activeCollateralCount;
    uint256 borrowCount;
}

function getUserAccountData(address user)
    external
    view
    returns (UserAccountData memory);
```

### Events

```solidity
// Adapter — emitted when a user proxy is created
event UserProxyCreated(address indexed user, address indexed proxy);

// Spoke — emitted on every (partial or full) liquidation
event LiquidationCall(
    address indexed user,
    address indexed liquidator,
    uint256 collateralSharesLiquidated,
    /* … other fields … */
);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | Calls `Lens.estimateLiquidation()` | Gets `(amounts, vaults)` for the target |
| **Liquidator** | Calls `liquidate(...)` (direct mode) | Position liquidated, vault redeemed to liquidator's BTC key |
| **Liquidator** | Calls `liquidateWithLLP(...)` (LLP mode) | Position liquidated, vault escrowed, liquidator paid WBTC at sell discount |
| **Arbitrageur** | Pays WBTC to LLP via `swapWbtcForVault` | Vault released and redeemed to arbitrageur; Hub draw restored |

Liquidation is permissionless. Operators without keeper status use the
LLP path and receive WBTC instantly; the arbitrageur completes the
redemption later, restoring the Hub draw.
