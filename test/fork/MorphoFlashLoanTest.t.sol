// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Types} from "./base/types.sol";
import {IBTCVaultSwap} from "../../lib/contracts/src/applications/aave/interfaces/IBTCVaultSwap.sol";
import {AaveAdapter} from "../../lib/contracts/src/applications/aave/AaveAdapter.sol";
import {IAaveOracle} from "../../lib/contracts/lib/aave-v4/src/spoke/interfaces/IAaveOracle.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../src/LiquidationRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UniswapV4Base} from "./base/UniswapV4Base.sol";
import {console} from "forge-std/console.sol";
import {
    PoolKey,
    Currency,
    IHooks,
    IPoolManager
} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {TBVHelper} from "./base/TBVHelper.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../src/LiquidationRouter.sol";

contract MorphoFlashLoanTest is UniswapV4Base, TBVHelper {
    address internal ADMIN = vm.addr(69420);

    function test_MORPHO_LIQUIDATION_TEST0() external {
        Types.TestParams memory params = LIQUIDATION_TESTS[0];
        vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

        address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());

        _setUpMorphoBlue(params.tbvContracts.debtTokens);
        _setUpUniswap(
            params.tbvContracts.debtTokens,
            _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
            wbtc
        );

        PoolKey[] memory poolKeys = _getPoolKeys();
        LiquidationRouter router =
            new LiquidationRouter(ADMIN, params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        flashDatas[0] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.Morpho,
            venueAddress: MORPHO_BLUE,
            token: params.tbvContracts.debtTokens[0],
            swapData: abi.encode()
        });

        flashDatas[1] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.Morpho,
            venueAddress: MORPHO_BLUE,
            token: params.tbvContracts.debtTokens[1],
            swapData: abi.encode()
        });

        uint256 netWbtcBeforePayment;
        LiquidationTypes.VenueDebt[] memory venueDebts;

        {
            bytes[] memory datas = new bytes[](1);
            datas[0] = abi.encodeWithSelector(
                router.liquidate.selector,
                LiquidationTypes.LiquidationData({
                    borrower: params.liquidation.borrower, minWbtcProfit: type(uint256).max
                }),
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
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
            flashDatas,
            swapDatas
        );
    }

    function _setUpMorphoBlue(address[] memory debtTokens) internal {
        for (uint256 i = 0; i < debtTokens.length; i++) {
            deal(debtTokens[i], MORPHO_BLUE, 2 ** 96);
        }
    }
}
