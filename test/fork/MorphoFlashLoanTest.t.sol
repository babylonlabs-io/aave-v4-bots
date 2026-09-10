// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Types} from "./base/Types.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../contracts/LiquidationRouter.sol";
import {UniswapV4Base} from "./base/UniswapV4Base.sol";
import {TBVForkFixture} from "./base/TBVForkFixture.sol";
import {PoolKey} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {TBVHelper} from "./base/TBVHelper.sol";

contract MorphoFlashLoanTest is UniswapV4Base, TBVForkFixture, TBVHelper {
    address internal ADMIN = vm.addr(69420);

    function test_MORPHO_LIQUIDATION_TEST0() external {
        Types.LiquidationScenario memory scenario = LIQUIDATION_SCENARIOS[0];
        vm.createSelectFork(vm.rpcUrl(scenario.network), scenario.blockNumber);

        // Order matters: the fork switch above discards anything deployed before it, so the protocol
        // is deployed onto the fork and only then is the position built on top of it.
        _deployTbvOnFork();
        address who = _createLiquidatablePosition(scenario);

        address[] memory debtTokens = _debtTokens();
        address wbtc = address(vaultSwap.WBTC());

        _setUpMorphoBlue(debtTokens);
        _setUpUniswap(debtTokens, _getWbtcPriceAgainstTokens(address(adapter), debtTokens), wbtc);

        PoolKey[] memory poolKeys = _getPoolKeys();
        LiquidationRouter router = new LiquidationRouter(ADMIN, address(preview), address(vaultSwap));

        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        flashDatas[0] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.Morpho,
            venueAddress: MORPHO_BLUE,
            token: debtTokens[0],
            swapData: abi.encode()
        });

        flashDatas[1] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.Morpho,
            venueAddress: MORPHO_BLUE,
            token: debtTokens[1],
            swapData: abi.encode()
        });

        uint256 netWbtcBeforePayment;
        LiquidationTypes.VenueDebt[] memory venueDebts;

        {
            bytes[] memory datas = new bytes[](1);
            datas[0] = abi.encodeWithSelector(
                router.liquidate.selector,
                LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: type(uint256).max}),
                flashDatas,
                new LiquidationTypes.SwapData[](0)
            );

            // Run the revert test to gain insight into the liquidation process and the expected WBTC profit before payment
            vm.prank(ADMIN);
            (, bytes[] memory results) = router.multicall(datas, false);
            (netWbtcBeforePayment, venueDebts) =
                abi.decode(_eliminateSelector(results[0]), (uint256, LiquidationTypes.VenueDebt[]));
        }

        uint256 quoteWbtc = 0;
        for (uint256 i = 0; i < venueDebts.length; i++) {
            quoteWbtc += _quoteWbtcExactOut(poolKeys[i], wbtc, venueDebts[i].amount);
        }

        vm.assertGt(
            netWbtcBeforePayment,
            quoteWbtc,
            "Expected net WBTC before payment to be greater than the sum of venue debts"
        );

        LiquidationTypes.SwapData[] memory swapDatas = new LiquidationTypes.SwapData[](2);
        swapDatas[0] = _encodeSwapWbtcExactDebtOut(poolKeys[0], wbtc, venueDebts[0].amount);
        swapDatas[1] = _encodeSwapWbtcExactDebtOut(poolKeys[1], wbtc, venueDebts[1].amount);

        vm.prank(ADMIN);
        router.liquidate(LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: 0}), flashDatas, swapDatas);
    }

    function _setUpMorphoBlue(address[] memory debtTokens) internal {
        for (uint256 i = 0; i < debtTokens.length; i++) {
            deal(debtTokens[i], MORPHO_BLUE, 2 ** 96);
        }
    }
}
