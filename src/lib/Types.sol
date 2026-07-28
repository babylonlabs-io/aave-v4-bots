// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TokenAmountLib} from "vault-contracts/applications/aave/lib/types/TokenAmountLib.sol";

/// @notice Shared types for the liquidation bot.
library Types {
    /// @notice Which protocol a flash venue is, and therefore which entrypoint and callback `VenueManager` uses for it.
    /// @dev The UniswapV4 variants are the ones that need a setup step; see `VenueManager._venueRequiresSetup`.
    enum VenueType {
        AaveV3,
        Morpho,
        UniswapV4FlashSwap,
        UniswapV4FlashLoan
    }

    /// @notice What to liquidate, and the floor below which it is not worth doing.
    /// @param borrower The account to liquidate.
    /// @param minWbtcProfit The WBTC that must remain once every flash venue is repaid, or the whole call reverts.
    struct LiquidationData {
        address borrower;
        uint256 minWbtcProfit;
    }

    /// @notice One source of flash liquidity: where to borrow a token from.
    /// @param venueType The protocol behind `venueAddress`.
    /// @param venueAddress The pool / venue contract to borrow from.
    /// @param token The token to borrow. The amount is derived from the borrower's debt, not given here.
    /// @param swapData Venue-specific route; only needed by swap-based venues (e.g. the encoded UniswapV4 `PoolKey`),
    ///        empty for plain flash-loan venues.
    struct FlashData {
        VenueType venueType;
        address venueAddress;
        address token;
        bytes swapData; // non-empty in case venueType is UniswapV4FlashSwap | ...
    }

    /// @notice One dex-aggregator call, used to sell the seized WBTC back into a borrowed token.
    /// @dev Built off-chain (that is what the `BelovedError` simulation path exists for) and executed verbatim, so the
    ///      router trusts whatever the owner passes here.
    /// @param dexAggRouter The aggregator to call. It is approved to pull WBTC for the duration of the call only.
    /// @param callData The swap calldata to send it.
    struct SwapData {
        address dexAggRouter;
        bytes callData;
    }

    /// @dev What each phase contains:
    /// - Setup:    For SwapVenue that requires a special setup, call the venue to set up flashloan.
    /// - FlashLoan: Call the venue to flashloan the required amount of debt tokens.
    /// - LiquidationAndSwap: Call the liquidation venue to liquidate the position and swap the collateral to the required debt tokens.
    enum LiquidationPhase {
        Setup,
        FlashLoan,
        LiquidationAndSwap
    }

    /// @notice The whole state of an in-flight liquidation.
    /// @dev This is the state machine's cursor. Because every flash venue returns control through a callback, the
    ///      router cannot keep its progress on the stack: it ABI-encodes this struct, forwards it through the venue,
    ///      and decodes it on the way back in (`VenueManager._resumeAfterCallback`).
    /// @param phase Which phase is running.
    /// @param i Index into `flashDatas` of the venue this phase is currently on.
    /// @param liquidationData The borrower and profit floor, as passed to `liquidate`.
    /// @param flashDatas The flash venues to draw from, in order.
    /// @param swapDatas The dex-aggregator calls to run after liquidating.
    /// @param reserveDebtsToLiquidate The borrower's debt in each reserve token, indexed by `reserveTokens`.
    /// @param wbtcPayment The extra WBTC owed to the LLP for realising the seized BTC vault collateral.
    /// @param reserveTokens Every reserve underlying, in spoke order.
    struct LiquidationIteration {
        LiquidationPhase phase;
        uint256 i;

        LiquidationData liquidationData;
        FlashData[] flashDatas;
        SwapData[] swapDatas;

        uint256[] reserveDebtsToLiquidate;
        uint256 wbtcPayment;

        address[] reserveTokens;
    }

    /// @notice An amount of a token owed back to a flash venue before the transaction can end.
    /// @dev use in error revert for dex swap integration
    struct VenueDebt {
        address token;
        address venue;
        uint256 amount;
    }
}
