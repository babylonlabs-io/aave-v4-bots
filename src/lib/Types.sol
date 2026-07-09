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

        uint256 minCollateralOut;
        uint256[] maxDebtRepay;
        uint256 maxWbtcPayment;

        uint256 minWbtcProfit;
    }

    struct FlashLoanData {
        VenueType venueType;
        address venueAddress;
        address token;
        uint256 amount;
        bytes swapData; // non-empty in case venueType is UniswapV4 | ...
    }

    struct SwapData {
        address dexAggRouter;
        bytes callData;
    }

    /// @dev What each phase contains:
    /// - Lens:     Call AaveAdapterLens to determine debts[] and wbtcPayment.
    ///             This later be used to determine flashLoanTokenAmounts[].
    ///             Approve tokens to AaveAdapter for later liquidation.
    /// - Setup:    For SwapVenue that requires a special setup, call the venue to set up flashloan.
    enum LiquidationPhase {
        Lens,
        Setup,
        FlashLoan,
        LiquidationExecution,
        Swap
    }

    struct LiquidationIteration {
        LiquidationPhase phase;
        uint256 i;

        FlashLoanData[] flashLoanTokenAmounts;
        LiquidationData liquidationData;
        SwapData[] swapData;
    }
}
