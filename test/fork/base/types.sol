// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library Types {
    struct Liquidation {
        string network;
        uint256 blockNumber;
        address borrower;
    }

    struct TBVContracts {
        address btcVaultSwap;
        address aaveAdapter;
        address lens;
        address[] debtTokens;
    }

    struct TestParams {
        Liquidation liquidation;
        TBVContracts tbvContracts;
    }
}
