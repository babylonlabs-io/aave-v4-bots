// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library Types {
    struct Liquidation {
        uint256 blockNumber;
        address borrower;
    }

    struct TBVContracts {
        address btcVaultSwap;
        address aaveAdapter;
        address lens;
    }

    struct UniswapFlashSwapTestCaseParams {
        Liquidation liquidation;
        TBVContracts tbvContracts;
    }
}
