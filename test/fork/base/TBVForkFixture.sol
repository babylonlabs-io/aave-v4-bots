// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {AaveAdapterMultiCollateralLoanBase} from "tbv-test/applications/aave/AaveAdapterMultiCollateralLoanBase.sol";
import {IAaveAdapterConfig} from "vault-contracts/applications/aave/interfaces/IAaveAdapterConfig.sol";
import {TokenValueLib} from "vault-contracts/applications/aave/lib/TokenValueLib.sol";
import {Types} from "./Types.sol";

/// @title TBVForkFixture
/// @notice Deploys the TBV protocol fresh onto a fork and builds a liquidatable position on it.
///
/// @dev The fork supplies only the *third-party* venue bytecode the router borrows from — UniswapV4's
///      PoolManager/Router/Permit2 and Morpho Blue — which is the one thing that cannot be deployed
///      from this repo. Everything TBV comes from the `lib/tbv-contracts` submodule these tests are
///      compiled against.
///
///      That split is the whole point. Pinning a live TBV deployment instead means the tests compile
///      against submodule source while executing against whatever bytecode is on the testnet, and the
///      two can only agree while the testnet is redeployed in lockstep with every submodule bump. It
///      is also the split the e2e liquidator suite already makes (see `AGENTS.md`): real venues,
///      freshly deployed protocol.
///
///      Deploying fresh also buys control the pinned fixtures never had. Whether a liquidation leaves
///      excess collateral value — and therefore whether the LLP charges a fairness payment, which is
///      what draws on the WBTC flash venue — is a property of the borrow-to-collateral ratio at
///      liquidation time. Here that is a scenario parameter rather than a borrower who happened to be
///      in the right state at some block.
abstract contract TBVForkFixture is AaveAdapterMultiCollateralLoanBase {
    /// @notice Aave base currency, 1e26 per USD. Scenario values are denominated in this.
    uint256 internal constant USD = AAVE_VALUE_BASE;

    /// @notice Price and unit of the vaultBTC collateral, tracked across the scenario's price drop.
    /// @dev Mirrors what the base configures the vaultBTC feed at, and is kept in step by
    ///      `_createLiquidatablePosition` so collateral values stay expressible in USD after the drop.
    TokenValueLib.TokenData internal vaultBTCData = TokenValueLib.TokenData({price: BTC_PRICE_USD * 1e8, unit: 1e8});

    /// @notice The borrower every scenario builds. `alice` from the contracts repo's test base.
    address internal borrower;

    /// @dev Forge calls `setUp` before the test body, which is *before* `vm.createSelectFork`
    ///      selects the fork — and a fork switch discards contracts deployed under the previous
    ///      state. So the base's deployment is deferred and run by `_deployTbvOnFork` instead, from
    ///      inside the test once the fork is live.
    function setUp() public virtual override {}

    /// @notice Deploy the whole TBV stack onto the currently selected fork.
    /// @dev Beyond the base deployment this wires the one thing a router-driven liquidation needs
    ///      and the plain adapter tests do not: the LLP as a spoke on the Hub's WBTC asset, so
    ///      `BTCVaultSwap` can draw the WBTC it pays the liquidator. The base already lists WBTC as
    ///      a Spoke reserve, so the router's `_getReserves()` sees it and can size a WBTC flash
    ///      borrow for the fairness payment.
    function _deployTbvOnFork() internal {
        AaveAdapterMultiCollateralLoanBase.setUp();

        // The feed is redeployed at its starting price, so the tracked copy has to go back with it.
        // A suite that forks twice in one test would otherwise size its second position against the
        // first one's post-drop price and quietly build a different scenario than the one it names.
        vaultBTCData = TokenValueLib.TokenData({price: BTC_PRICE_USD * 1e8, unit: 1e8});

        _addSpokeToHub(wbtcAssetId, address(vaultSwap));

        // Uncapped: the scenarios below choose position sizes to land on a specific health factor,
        // and a cap would silently clip one of them into a different scenario.
        adapterConfig.setPositionSizeParams(
            IAaveAdapterConfig.PositionSizeParams({
                maxPositionBTC: type(uint256).max, maxVaultsPerPosition: type(uint256).max
            })
        );
    }

    /// @notice Fork, deploy the protocol onto it, and build the scenario's liquidatable position.
    /// @dev The three steps are strictly ordered — a fork switch discards contracts deployed before
    ///      it — so they are packaged together rather than left to each call site to get right.
    /// @param scenario The fork to pin and the position to construct.
    /// @return who The borrower.
    function _forkAndBuild(Types.LiquidationScenario memory scenario) internal returns (address who) {
        vm.createSelectFork(vm.rpcUrl(scenario.network), scenario.blockNumber);
        _deployTbvOnFork();
        who = _createLiquidatablePosition(scenario);
    }

    /// @notice Build a borrower that is liquidatable right now, per `scenario`.
    /// @dev Collateral first, then the borrow, then the price drop that pushes the health factor under
    ///      1 — the same order a real position reaches this state in.
    /// @param scenario The position to construct. See `Types.LiquidationScenario`.
    /// @return who The borrower. Its proxy holds the debt; the vault is the collateral.
    function _createLiquidatablePosition(Types.LiquidationScenario memory scenario) internal returns (address who) {
        who = alice;
        borrower = who;

        // One vault. The adapter seizes exactly the head of the borrower's list, so a single vault
        // makes the seized collateral — and therefore the profit these suites assert on — the whole
        // position rather than a prefix of it.
        createActiveVault(who, TokenValueLib.valueToAmountUp(scenario.collateralValueUsd * USD, vaultBTCData));

        // The Core Spoke allows one debt reserve per position, so the whole borrow is USDC.
        vm.prank(who);
        adapter.borrowFromCorePosition(
            loanReserveId, TokenValueLib.valueToAmountDown(scenario.borrowValueUsd * USD, loanAssetData), who
        );

        priceFeed.simulatePriceDrop(scenario.dropPercent);
        vaultBTCData = dropPrice(vaultBTCData, scenario.dropPercent);
    }

    /// @notice The debt token every fork scenario borrows.
    function _debtTokens() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(loanAsset);
    }
}
