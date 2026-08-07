# Aave v4 Vault Arbitrageurs

## Overview

The Aave v4 integration with Babylon's Trustless Bitcoin Vaults enables
BTC holders to use their Bitcoin as collateral for borrowing on
Ethereum. When borrowers become undercollateralized, their positions
can be liquidated. However, redeeming the underlying BTC from a vault
is restricted, which creates work for two cooperating roles —
liquidators and arbitrageurs — connected by the **BTCVaultSwap**
contract.

## The Problem

Liquidations are permissionless: anyone with debt tokens can liquidate
an undercollateralized position. But redeeming the underlying BTC is
not:

1. **Registered Application Keepers** — only pre-registered entities
   can initiate vault redemption.
2. **Multi-day Settlement Delay** — BTC redemption involves a
   challenge period of about three days.

Permissionless liquidators therefore cannot directly take BTC
redemption into their own hands. They need immediate WBTC liquidity to
keep operating.

## The Solution: BTCVaultSwap

`BTCVaultSwap` is the Liquidation Liquidity Provider (LLP) deployed in
this integration. When a liquidator calls
`AaveAdapter.liquidateWithLLP(...)`:

1. The Adapter repays the borrower's debt and seizes the vault.
2. The vault is transferred to BTCVaultSwap.
3. BTCVaultSwap **draws WBTC from the Aave Hub at a sell discount**
   (`sellDiscountBps`) and pays it to the liquidator immediately.
4. The vault sits in escrow with a debt to the Hub equal to the WBTC
   drawn.

The arbitrageur is the second half of the system: a registered keeper
who later acquires the escrowed vault by paying the Hub debt + a
protocol fee, and redeems the vault to their own BTC key.

## Arbitrageur Role

Arbitrageurs are **pre-registered Aave application keepers** who have
the exclusive right to acquire escrowed vaults via
`BTCVaultSwap.swapWbtcForVault`. Registration is gated by the
`ApplicationRegistry` contract.

### Why Registration Is Required

- Only registered keepers can redeem vaults for actual BTC through the
  Babylon protocol.
- Registration involves off-chain setup of the keeper's Bitcoin-side
  signing infrastructure.

### Arbitrageur Economics

When acquiring a vault, arbitrageurs pay slightly less than the full
WBTC-equivalent of the vault BTC. The exact spread depends on
`sellDiscountBps` (how much the Hub took off when paying the
liquidator) and `discountCommissionBps` (the protocol fee on
profitable vaults).

| Component | Example (1 BTC vault) |
|-----------|----------------------|
| Vault BTC value | 1.00 BTC |
| Liquidator received (paid by Hub at sell discount) | ~0.97 WBTC |
| Arbitrageur pays (Hub debt + fee) | ~0.98 WBTC |
| Arbitrageur receives | 1.00 BTC (after BTC settlement) |
| Protocol fee | ~0.01 WBTC |

> **Note**: `sellDiscountBps` and `discountCommissionBps` are protocol
> parameters held on the `BTCVaultSwap` contract; check the deployment
> for current values.

### Interest Accrual

While a vault is escrowed, the Hub debt accrues interest. The
arbitrageur pays the **current** Hub debt + protocol fee, so the
longer a vault sits in escrow, the more it costs to acquire — and the
profit margin shrinks. This incentivises arbitrageurs to act quickly.

The contract function
`BTCVaultSwap.previewEscrowedVaults(bytes32[])` returns, for each
vault:

| Field | Meaning |
|-------|---------|
| `amountVault` | Original BTC in the vault (sats) |
| `amountDebt` | Current Hub debt = principal + accrued interest |
| `amountInterest` | Interest accrued above the escrow-time principal |
| `amountFee` | Protocol fee (only set when profitable) |
| `amountWbtcToAcquire` | What the arbitrageur pays = `amountDebt + amountFee` |
| `isProfitable` | `true` iff vault WBTC-equivalent > `amountDebt` |

## Arbitrageur Bot

The bot automates monitoring and acquisition of escrowed vaults. It
always runs the arbitrage engine; when `ADAPTER_ADDRESS` and
`LENS_ADDRESS` are also configured, the same process also runs the
liquidation engine with the same executor and risk gate.

### Bot Operation

1. **Polling** — every `POLLING_INTERVAL_MS`, the bot fetches
   `/escrowed-vaults` from the Ponder indexer. The endpoint enriches
   indexed vault IDs by calling `previewEscrowedVaults` on chain.
2. **Re-check on chain** — for each vault, the bot calls
   `previewEscrowedVaults([vaultId])` directly before swapping. The
   bot trusts the on-chain answer, not the indexer's cached one.
3. **Acquire** — if profitable, the bot:
   - Ensures WBTC approval for BTCVaultSwap.
   - Calls `swapWbtcForVault(vaultId, maxWbtcIn)` where
     `maxWbtcIn = currentDebt + currentDebt * MAX_SLIPPAGE_BPS / 10000`.
4. **Batch** — every affordable vault is broadcast first, then all receipts are awaited
   together (each up to `TX_RECEIPT_TIMEOUT_MS`), the same shape the liquidation engine uses.
   Two bounds apply while sending:
   - **Exposure** — each send reserves a risk-gate slot, so `RISK_MAX_IN_FLIGHT` caps how many
     acquisitions are in flight at once.
   - **Inventory** — the risk gate reserves each vault's `maxWbtcIn` against the signer's WBTC
     until the acquisition settles, and blocks one the balance cannot cover. The reservation is
     shared with the liquidation engine, which spends the same WBTC (`wbtcPayment`) — so neither
     engine can commit balance the other has already claimed.

In `AUTO` mode the bot signs and broadcasts with the configured signer.
In `MANUAL` mode it writes a content-hashed proposal to the Postgres
StateStore and notifies an operator, who reviews and broadcasts it with
`operator-cli`. The vault is redeemed to the arbitrageur's
keeper-registered BTC key inside the same transaction.

### Configuration

| Parameter | Description | Required? | Default |
|-----------|-------------|-----------|---------|
| `CLIENT_RPC_URL` | Ethereum RPC endpoint | Yes | — |
| `PONDER_URL` | Ponder indexer API URL | Yes | — |
| `VAULT_SWAP_ADDRESS` | BTCVaultSwap contract address | Yes | — |
| `WBTC_ADDRESS` | WBTC token address | Yes | — |
| `VAULT_KEEPER_ADDRESS` | Keeper the vault is redeemed to when the executor isn't one itself (uses `swapWbtcForVaultOnBehalf`) | No | — |
| `POLLING_INTERVAL_MS` | How often to check for escrowed vaults | No | `30000` |
| `MAX_SLIPPAGE_BPS` | Slippage tolerance (basis points) over `currentDebt` | No | `100` |
| `VAULT_PROCESSING_DELAY_MS` | Throttle between acquisition broadcasts. Acquisitions are batched, so not a per-acquisition pause. `0` disables | No | `0` |
| `TX_RECEIPT_TIMEOUT_MS` | Receipt wait timeout | No | `120000` |
| `EXECUTION_MODE` | `AUTO` signs and broadcasts; `MANUAL` persists proposals | No | `AUTO` |
| `ARBITRAGEUR_PRIVATE_KEY` | Default local signer key ref target; not used with KMS or MANUAL | AUTO + local | — |
| `SECRETS_PROVIDER` | Secret reference backend: `env` or `aws` | No | `env` |
| `SIGNER_SOURCE` | AUTO signer backend: `local` or `aws` KMS | No | `local` |
| `SIGNER_KEY_REF` | Local signer secret reference | No | `ARBITRAGEUR_PRIVATE_KEY` |
| `KMS_KEY_ID` | AWS KMS key id/ARN/alias for `SIGNER_SOURCE=aws` | KMS only | — |
| `SIGNER_ADDRESS` | Expected KMS signer address | No | — |
| `AWS_REGION` | AWS region for KMS and Secrets Manager | No | — |
| `DATABASE_URL` | Enables Postgres StateStore; required for MANUAL proposals | MANUAL only | — |
| `PERSISTENCE_SCHEMA` | Schema for bot StateStore tables | No | `bot` |
| `MANUAL_EXECUTOR_ADDRESS` | Address the operator signs/broadcasts from | MANUAL only | — |
| `MANUAL_EXECUTOR_KIND` | Operator custody model: `eoa` or `safe` | MANUAL only | — |
| `MANUAL_INTENT_TTL_MS` | Expire un-actioned MANUAL proposals after this many ms; `0` disables | No | `10800000` |
| `MANUAL_INTENT_STUCK_MS` | Alert on stuck MANUAL intents after this many ms; `0` disables | No | `3600000` |
| `NOTIFIER` | Notification backend: `none` or `slack` | No | `none` |
| `SLACK_WEBHOOK_REF` | Secret reference for Slack webhook URL | if `NOTIFIER=slack` | — |
| `ADAPTER_ADDRESS` | Enables optional liquidation engine when set with `LENS_ADDRESS` | Liquidation only | — |
| `LENS_ADDRESS` | Lens address for optional liquidation mode | Liquidation only | — |
| `LIQUIDATION_POLLING_INTERVAL_MS` | Poll interval for the optional liquidation engine | No | `12000` |
| `LIQUIDATION_FUNDING` | Funding mode for the optional liquidation engine: `inventory` or `flash`. See the [liquidator overview](./liquidator-overview.md#funding-modes) | No | `inventory` |
| `RISK_MAX_CONSECUTIVE_FAILURES` | Auto-halt after consecutive failed actions | No | — |
| `RISK_MIN_PROFIT` | Profit floor in 8-decimal sats. Rejected at boot if the liquidation engine is enabled and inventory-funded (#27); allowed when it is off or flash-funded | No | — |
| `RISK_MAX_IN_FLIGHT` | Max in-flight actions across both engines. Unset = no cap. Size above the largest cascade you want to compete in | No | unlimited |
| `RISK_MAX_DATA_STALENESS_MS` | Maximum source data age | No | — |
| `RISK_START_HALTED` | Boot HALTED until resumed; `true` requires `RISK_CONTROL_TOKEN_REF` | No | `false` |
| `RISK_EXPECTED_CODE_HASHES` | Pinned bytecode map: `address=hash,...` | No | — |
| `RISK_CODE_CHECK_INTERVAL_MS` | Re-check interval for pinned bytecode | No | `300000` |
| `RISK_CONTROL_TOKEN_REF` | Secret reference enabling authenticated kill switch | if `RISK_START_HALTED=true` | — |
| `RISK_CONTROL_PORT` | Kill-switch server port, separate from metrics | No | `9095` |
| `RISK_CONTROL_HOST` | Kill-switch bind host | No | `127.0.0.1` |

### Requirements

- **Registration** — partnership agreement with the protocol, registered
  as an application keeper.
- **WBTC Capital** — sufficient WBTC to front vault acquisitions.
- **Infrastructure** — reliable RPC access and monitoring.

## Contract Interfaces

### BTCVaultSwap (view functions)

```solidity
// Whether a specific vault is currently in escrow
function isVaultEscrowed(bytes32 vaultId) external view returns (bool);

// Preview cost and profitability for a batch of escrowed vaults
struct EscrowedVaultPreviewResult {
    bytes32 vaultId;
    uint256 amountVault;          // original vault BTC (sats)
    uint256 amountDebt;           // current Hub debt (= principal + interest)
    uint256 amountInterest;       // interest accrued above escrow-time principal
    uint256 amountFee;            // protocol fee (0 if !isProfitable)
    uint256 amountWbtcToAcquire;  // amountDebt + amountFee
    bool    isProfitable;
}

function previewEscrowedVaults(bytes32[] calldata vaultIds)
    external
    view
    returns (EscrowedVaultPreviewResult[] memory);

// Preview interest accrued for a single escrowed vault
function previewVaultInterest(bytes32 vaultId)
    external
    view
    returns (uint256 interest);
```

### BTCVaultSwap (state-changing functions)

```solidity
// Acquire a vault and have it redeemed to msg.sender's BTC key in same tx.
// Caller must be a registered application keeper.
function swapWbtcForVault(bytes32 vaultId, uint256 maxWbtcIn)
    external
    returns (uint256 amountWbtcIn);

// Same as above, but the redemption is to onBehalfOf's BTC key.
function swapWbtcForVaultOnBehalf(
    bytes32 vaultId,
    uint256 maxWbtcIn,
    address onBehalfOf
) external returns (uint256 amountWbtcIn);

// Pay down accrued interest on an escrowed vault without acquiring it.
// Useful for keeping a vault profitable when the arbitrageur is willing
// to wait.
function repayVaultInterest(bytes32 vaultId, uint256 wbtcToRepay)
    external
    returns (uint256 wbtcPaid);
```

### Events

```solidity
// Emitted when a vault enters escrow (after liquidation)
event AddedVault(bytes32 indexed vaultId);

// Emitted when a vault leaves escrow (acquired by arbitrageur)
event RemovedVault(bytes32 indexed vaultId);

// Emitted when an arbitrageur acquires a vault
event WbtcSwappedForVault(
    address indexed payer,
    address indexed onBehalfOf,
    bytes32 vaultId,
    uint256 wbtcAmount
);

// Emitted when interest is repaid against an escrowed vault
event VaultInterestRepaid(
    bytes32 indexed vaultId,
    address indexed payer,
    uint256 wbtcPaid
);
```

## Summary

| Actor | Action | Result |
|-------|--------|--------|
| **Liquidator** | `liquidateWithLLP(...)` on AaveAdapter | Vault escrowed in BTCVaultSwap; liquidator paid WBTC at sell discount, drawn from Hub |
| **BTCVaultSwap** | Holds vault in escrow with Hub debt outstanding | Bridges permissionless liquidation to registered redemption |
| **Arbitrageur** | `swapWbtcForVault(...)` | Pays Hub debt + protocol fee; vault redeemed to arbitrageur's BTC key in same tx |
| **Aave Hub** | Provided WBTC at liquidation, reclaimed at acquisition | Net debt zero after the round-trip |
