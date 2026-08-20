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

### Funding Modes

Set by `LIQUIDATION_FUNDING`. This is a separate axis from the redemption
mode above — funding decides where the repayment money comes from,
redemption decides what the liquidator gets back. All four combinations
are valid.

| Mode | Contract called | Repayment source | Signer must hold |
|------|-----------------|------------------|------------------|
| `inventory` (default) | `AaveAdapter` | The signer's own token balances | Debt tokens + WBTC + gas |
| `flash` | `LiquidationRouter` | Borrowed per debt token, repaid from the seized collateral in the same tx | Gas only |

Under `flash`, the router borrows each debt token from the venue named in
`FLASH_SWAP_POOLS`, liquidates, and repays that venue out of what it
seized — all within one transaction, so nothing is owed after it lands.
The WBTC fairness payment is covered by a separate flash *loan*
(`WBTC_FLASH_LOAN_ADDRESS`), repaid in WBTC. Profit is swept to the
router's `owner`, which must be the bot's signer.

Two consequences worth knowing before switching:

- **The profit floor becomes usable.** `flash` probes the router before
  sending and gets back a real WBTC profit, so `RISK_MIN_PROFIT` gates
  every liquidation. Under `inventory` it is rejected at boot, because
  that path cannot price its own actions.
- **`FLASH_MAX_SLIPPAGE_BPS` and `RISK_MIN_PROFIT` are different
  floors, and you want both.** `RISK_MIN_PROFIT` is *absolute*, checked
  *off-chain before sending* — "is this opportunity worth attempting?"
  `FLASH_MAX_SLIPPAGE_BPS` is *relative to the probe's quote* and is
  enforced *on-chain at execution* via `minWbtcProfit` — "how far may
  the result decay before it must revert?" The off-chain check stops
  constraining anything the moment the transaction is broadcast, and the
  flash swap fills at whatever price the pool gives, so the on-chain
  bound is the only protection against a thin or moved pool. Neither
  substitutes for the other: an absolute floor is no slippage bound on a
  large position (1,000 sats would let a 4,000,000-sat quote settle at
  1,000), and a relative one never says a trade is too small to be worth
  the gas. When both are set the on-chain floor is whichever binds
  harder, so an action the gate admitted cannot settle below the
  operator's declared minimum.
- **The WBTC flash loan is not an edge case.** BTC vaults are
  indivisible, so a liquidation seizes whole vaults; whatever the seized
  vault is worth beyond the debt is owed back to the borrower as the LLP
  fairness payment, which the adapter pulls from the router in WBTC.
  Only a position deep enough underwater to consume its vault entirely
  avoids one, which is why `WBTC_FLASH_LOAN_ADDRESS` is required rather
  than situational.

## Liquidation Bot

The bot automates monitoring and execution.

### Components

- **Ponder Indexer** — indexes Spoke events (`Supply`, `Withdraw`,
  `LiquidationCall`) and the Adapter event (`UserProxyCreated`).
  Tracks active positions and the proxy → borrower mapping.
- **Liquidation Client** — polls the indexer's
  `/liquidatable-positions` endpoint and either executes liquidations
  directly or persists proposals for an operator, depending on
  `EXECUTION_MODE`.

### Bot Operation

1. **Discover reserves** — at boot, enumerates the Spoke's reserves in id
   order. A repay amount is charged to the token of the reserve it is indexed
   by; those flagged borrowable are what the signer holds and approves.
2. **Approve** — under `inventory` funding, ensures `MAX_UINT256`
   allowance on every debt token and on WBTC for the AaveAdapter. WBTC
   approval is required because the adapter pulls the fairness payment
   and, in direct-redemption mode, the redemption fee directly from
   `msg.sender`. In `AUTO` mode the bot signs the approval; in `MANUAL`
   mode it proposes the approval for the operator to sign.
   Under `flash` funding this step does nothing: the bot never moves its
   own tokens, so it grants no allowances.
3. **Poll** — fetches `/liquidatable-positions` from Ponder every
   `POLLING_INTERVAL_MS`.
4. **Estimate** — calls
   `AaveAdapterLens.estimateLiquidation(proxy, isDirectRedemption)` per
   candidate; bumps each amount by 1%.
5. **Vet** — under `inventory` funding, simulates every candidate
   against the Adapter and drops reverts. Under `flash` funding this is
   a *probe* of `LiquidationRouter` instead, which both proves the
   candidate executable and returns the WBTC profit it would yield.
6. **Liquidate** — under `inventory` funding, calls `liquidate` or
   `liquidateWithLLP` on the Adapter based on `IS_DIRECT_REDEMPTION`.
   Under `flash` funding, calls `LiquidationRouter.liquidate` instead,
   which borrows, liquidates, repays and sweeps the profit in one
   transaction. In `AUTO` mode the bot signs and broadcasts with the
   configured signer. In `MANUAL` mode it writes a content-hashed
   proposal to the Postgres StateStore and notifies an operator, who
   reviews and broadcasts it with `operator-cli`.

### Configuration

| Variable | Description | Required? | Default |
|----------|-------------|-----------|---------|
| `CLIENT_RPC_URL` | Ethereum RPC endpoint | Yes | — |
| `PONDER_URL` | Ponder indexer API URL | Yes | — |
| `ADAPTER_ADDRESS` | AaveAdapter address | Yes | — |
| `LENS_ADDRESS` | AaveAdapterLens address | Yes | — |
| `WBTC_ADDRESS` | WBTC token address | Yes | — |
| `LIQUIDATION_FUNDING` | `inventory` (repay from own balances) or `flash` (repay via `LiquidationRouter`). The only thing that selects the mode — the flash variables below are never inferred from | No | `inventory` |
| `LIQUIDATION_ROUTER_ADDRESS` | LiquidationRouter; its `owner` must be this bot's signer | flash | — |
| `FLASH_SWAP_VENUE_ADDRESS` | UniswapV4SwapVenue bound to that router | flash | — |
| `FLASH_SWAP_POOLS` | `token:currency0:currency1:fee:tickSpacing[:hooks]`; each must be WBTC/`<token>` | flash | — |
| `WBTC_FLASH_LOAN_ADDRESS` | Venue WBTC is flash-loaned from for the LLP fairness payment | flash | — |
| `WBTC_FLASH_LOAN_VENUE` | `morpho` or `aavev3` | No | `morpho` |
| `FLASH_MAX_SLIPPAGE_BPS` | How far realised profit may fall below the quote before the chain reverts; derives `minWbtcProfit` | No | `2000` |
| `IS_DIRECT_REDEMPTION` | `true` calls `liquidate`; otherwise calls `liquidateWithLLP` | No | `false` |
| `BTC_REDEEM_KEY` | BTC key for direct mode (must be non-zero) | direct mode | `bytes32(0)` |
| `LLP_ADDRESS` | LLP (BTCVaultSwap) address for LLP mode (must be non-zero) | LLP mode | `address(0)` |
| `EXECUTION_MODE` | `AUTO` signs and broadcasts; `MANUAL` persists proposals | No | `AUTO` |
| `LIQUIDATOR_PRIVATE_KEY` | Default local signer key ref target; not used with KMS or MANUAL | AUTO + local | — |
| `SECRETS_PROVIDER` | Secret reference backend: `env` or `aws` | No | `env` |
| `SIGNER_SOURCE` | AUTO signer backend: `local` or `aws` KMS | No | `local` |
| `SIGNER_KEY_REF` | Local signer secret reference | No | `LIQUIDATOR_PRIVATE_KEY` |
| `KMS_KEY_ID` | AWS KMS key id/ARN/alias for `SIGNER_SOURCE=aws` | KMS only | — |
| `SIGNER_ADDRESS` | Expected signer address (either source); boot fails on mismatch | No | — |
| `AWS_REGION` | AWS region for KMS and Secrets Manager | No | — |
| `DATABASE_URL` | Enables Postgres StateStore; required for MANUAL proposals | MANUAL only | — |
| `PERSISTENCE_SCHEMA` | Schema for bot StateStore tables | No | `bot` |
| `MANUAL_EXECUTOR_ADDRESS` | Address the operator signs/broadcasts from | MANUAL only | — |
| `MANUAL_EXECUTOR_KIND` | Operator custody model: `eoa` or `safe` | MANUAL only | — |
| `MANUAL_INTENT_TTL_MS` | Expire un-actioned MANUAL proposals after this many ms; `0` disables | No | `10800000` |
| `MANUAL_INTENT_STUCK_MS` | Alert on stuck MANUAL intents after this many ms; `0` disables | No | `3600000` |
| `NOTIFIER` | Notification backend: `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for Slack webhook URL | if `NOTIFIER=slack` | — |
| `RISK_MAX_CONSECUTIVE_FAILURES` | Auto-halt after consecutive failed actions | No | — |
| `RISK_MIN_PROFIT` | Profit floor in 8-decimal sats. Rejected at boot under `LIQUIDATION_FUNDING=inventory` (no expected-profit source, #27); allowed under `flash`, which probes the router for one | inventory: must be unset | — |
| `RISK_MAX_IN_FLIGHT` | Max in-flight actions. Unset = no cap. Size above the largest cascade you want to compete in | No | unlimited |
| `RISK_MAX_DATA_STALENESS_MS` | Maximum source data age (also blocks a missing, malformed or future-dated timestamp) | No | — |
| `RISK_START_HALTED` | Boot HALTED until resumed; `true` requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | Pinned bytecode map: `address=hash,...` | No | — |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval for pinned bytecode | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference enabling authenticated kill switch | if `RISK_START_HALTED=true` | — |
| `RISK_CONTROL_PORT` | Kill-switch server port, separate from metrics | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host | No | `127.0.0.1` |
| `POLLING_INTERVAL_MS` | Position check frequency | No | `12000` |
| `TX_RECEIPT_TIMEOUT_MS` | Receipt wait timeout | No | `120000` |
| `METRICS_PORT` | Prometheus metrics port | No | `9090` |

### Requirements

- **Debt Tokens** — under `LIQUIDATION_FUNDING=inventory`, sufficient
  balance to repay positions. Under `flash`, none: `LiquidationRouter`
  borrows each debt token and repays it from the seized collateral in
  the same transaction.
- **WBTC** — under `inventory`, to cover the LLP fairness payment.
  Under `flash` it is borrowed too.
- **ETH** — for transaction gas. The only requirement in `flash` mode.
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
