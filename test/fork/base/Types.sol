// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library Types {
    /// @notice A liquidatable position to build on the fork, described rather than pointed at.
    /// @dev The TBV protocol is deployed fresh per test (`TBVForkFixture`), so a scenario says what
    ///      position to construct instead of naming a borrower on a live deployment. `network` and
    ///      `blockNumber` still pin the fork, because the venues the router borrows from are real
    ///      contracts at real addresses — and pinning is what lets foundry serve them from its RPC
    ///      cache rather than hitting the network on every run.
    /// @param network Foundry RPC alias to fork.
    /// @param blockNumber Block to pin the fork at. Chosen for venue liquidity, nothing else.
    /// @param collateralValueUsd Vault collateral to create, in whole USD at the pre-drop BTC price.
    /// @param borrowValueUsd Debt to take against it, in whole USD, split evenly across USDC and USDT.
    /// @param dropPercent Percentage the vaultBTC price drops afterwards, pushing health under 1.
    /// @param hasFairnessPayment Whether seizing the vault is expected to leave excess collateral
    ///        value, which the LLP pays out as a WBTC fairness payment. Asserted, not assumed: it is
    ///        the only thing that draws on the WBTC flash venue, so a scenario that quietly stopped
    ///        producing one would leave that venue untested while still passing.
    struct LiquidationScenario {
        string network;
        uint256 blockNumber;
        uint256 collateralValueUsd;
        uint256 borrowValueUsd;
        uint256 dropPercent;
        bool hasFairnessPayment;
    }

    /// @notice An escrowed-vault arbitrage to build on the fork.
    /// @param network Foundry RPC alias to fork.
    /// @param blockNumber Block to pin the fork at.
    /// @param collateralValueUsd Vault collateral to create, in whole USD at the pre-drop BTC price.
    /// @param borrowValueUsd Debt to take against it, in whole USD.
    /// @param dropPercent Percentage the vaultBTC price drops before the liquidation that escrows it.
    struct ArbitrageScenario {
        string network;
        uint256 blockNumber;
        uint256 collateralValueUsd;
        uint256 borrowValueUsd;
        uint256 dropPercent;
    }
}
