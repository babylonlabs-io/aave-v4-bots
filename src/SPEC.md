# Liquidation Smart Contract Specification

## Overview

The liquidation system is composed of three main components:

- **`LiquidationRouter`** — the main entry point for liquidations. It orchestrates the core liquidation process across its phases and iterations.
- **`VenueManager`** — the intermediary that communicates with the different venues to obtain flash swaps and flash loans. On every callback it receives — flash swap, flash loan, or setup — it forwards the current iteration's information to `LiquidationRouter` for further processing.
- **`WrappedVenues`** — adapters for venues that do not conform to the standard venue interface.

A **standard venue** is a flash-loan hub that transfers the borrowed token to `VenueManager` *before* invoking the callback, and is repaid afterwards via `ERC20.transferFrom(venueManager, venue, amount)`. Any flash-loan venue that instead requires the token to be transferred in by `VenueManager` before the callback returns must be adapted with a `WrappedVenue`. By this definition, all flash-swap venues are wrapped venues.

## Liquidation Process

Each liquidation proceeds through three phases:

1. **`SetUp`** — Prepares any wrapped venue that requires initialization before use. For example, `UniswapV4` requires its `PositionManager` to be locked before it can be used.
2. **`FlashLoan`** — `VenueManager` requests a flash loan or flash swap from every venue.
3. **`LiquidationAndSwap`** — `LiquidationRouter` performs the liquidation and swaps the earned `WBTC` into the debt tokens required for repayment.

### Phases 1 & 2

Every venue used in phases 1 and 2 exposes the following behavior:

- A callback function that the venue invokes on the borrower (`VenueManager`) once the flash loan or swap has been dispensed.
- Support for `ERC20.transferFrom(venueManager, venue, amount)`, used to return the borrowed token to the venue.

During these phases, a long chain of callbacks is triggered:

```
LiquidationRouter -> VenueManager -> Venue -> VenueManager -> LiquidationRouter -> ...
```

This continues until all flash loans and swaps have been obtained. Once the chain unwinds, `LiquidationRouter` performs the liquidation and swaps the earned `WBTC` into the debt tokens required for repayment.

At each flash loan/swap callback, `VenueManager` approves the debt token to the corresponding venue, so that the debt is repaid automatically as the callbacks resolve.

### Phase 3

In phase 3, `LiquidationRouter` performs the liquidation and swaps the earned `WBTC` into the debt tokens required for repayment. All swap calls are specified off-chain and passed into `LiquidationRouter` as parameters. `LiquidationRouter` executes these swap calls blindly, without validation — it is the responsibility of the off-chain system to ensure they are valid and will not revert.

### Post-Liquidation

After all phases have completed, `LiquidationRouter`:

- Revokes the approvals granted to `aaveAdapter` and `dexAggRouter`.
- Transfers any remaining token profit to the `auth` address.
