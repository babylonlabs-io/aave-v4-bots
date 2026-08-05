// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library Types {
    struct Liquidation {
        string network;
        uint256 blockNumber;
        address borrower;
        bool hasFairnessPayment;
    }

    struct TBVContracts {
        address btcVaultSwap;
        address aaveAdapter;
        address lens;
        address[] debtTokens;
    }

    struct LiquidationTestParams {
        Liquidation liquidation;
        TBVContracts tbvContracts;
    }

    struct Arbitrage {
        string network;
        uint256 blockNumber;
        bytes32[] vaultIds;
    }

    struct ArbitrageTestParams {
        Arbitrage arbitrage;
        TBVContracts tbvContracts;
    }
}
