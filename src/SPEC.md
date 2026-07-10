# Liquidation Smart Contract Specification

## Overview

The liquidation smart contracts can be broken down to three main components:
- Liquidation Router 
- Venue Manager
- Wrapped Venues

`LiquidationRouter` is the main entry point for liquidations. It handles the core liquidation process with phases and iterations.

`VenueManager` is responsible for communicating with different venues for flash swap and flash loan. On, every callback to `VenueManager` including (flash swap, flash loan, set up), it will forward the received iteration information to `LiquidationRouter` for further processing.

`WrappedVenues` are the venues that does not behave like a standard venue. A standard venue is a [flash loan] hub that gives `VenueManager` the token before the callback which is then followed by a `ERC20.transferFrom(venueManager, venue, amount)` to return the token back to the venue. If a [flash loan] venue requries the token to be transferred in by `VenueManager` before the callback ends, it should also be wrapped in a `WrappedVenue` contract. By this definition, all [flash swap] venues are wrapped venues.

## Liquidation Process

Each liquidation contains 3 phases:
1. `SetUp`: For all wrapped venues that requires a setup before using. For example `UniswapV4` requires the `PositionManger` to be locked before being used.
2. `FlashLoan`: `VenueManager` will request a flash loan/flash swap from all the venues.
3. `LiquidationAndSwap`: `LiquidationRouter` will perform the liquidation and swap the earned `WBTC` into debts required for payment.

### Phase 1 & 2

All venues in phase 1 & 2 come with this behavior:
- Implements a callback function that is called by the venue to the borrower (`VenueManager`) after the flash loan/swap is completed.
- Implements `ERC20.transferFrom(venueManager, venue, amount)` to return the token back to the venue.

In phase 1 and 2, a long chain of callbacks will be triggered:
`LiquidationRouter` -> `VenueManager` -> `Venue` -> `VenueManager` -> `LiquidationRouter` -> `VenueManager` -> `Venue` -> `VenueManager` -> `LiquidationRouter` ... until all flash loans/swaps are completed. After that, the `LiquidationRouter` will perform the liquidation and swap the earned `WBTC` into debts required for payment.

At each flash loan/swap callback, the `VenueManager` will approve the debt token to the according venue so that the debts are paid back automatically when the callbacks resolve themselves.

### Phase 3

In phase 3, the `LiquidationRouter` will perform the liquidation and swap the earned `WBTC` into debts required for payment. All swap calls are specified off-chain and passed into the `LiquidationRouter` as a parameter. The `LiquidationRouter` will blindly execute the swap calls without any validation. It is the responsibility of the off-chain system to ensure that the swap calls are valid and will not revert.

### Post liquidation

After all the phases are completed, the `LiquidationRouter` will:
- Revoke approvals for `aaveAdapter` and `dexAggRouter`.
- Transfer any token profit to `auth` address


