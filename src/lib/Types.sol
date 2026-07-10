// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TokenAmountLib} from "vault-contracts/applications/aave/lib/types/TokenAmountLib.sol";

library Types {
    enum VenueType {
        AaveV3,
        Morpho,
        UniswapV4FlashSwap,
        UniswapV4FlashLoan
    }

    struct LiquidationData {
        address borrower;
        uint256 minWbtcProfit;
    }

    struct FlashData {
        VenueType venueType;
        address venueAddress;
        address token;
        bytes swapData; // non-empty in case venueType is UniswapV4FlashSwap | ...
    }

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

    /// @dev use in error revert for dex swap integration
    struct VenueDebt {
        address token;
        address venue;
        uint256 amount;
    }
}
