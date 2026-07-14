// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

import {Types} from "./base/types.sol";
import {UniswapV4Base} from "./base/UniswapV4Base.sol";
import {Test} from "forge-std/Test.sol";
import {
    PoolKey,
    Currency,
    IHooks,
    IPoolManager
} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolInitializer_v4} from "../../lib/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {Actions} from "../../lib/v4-periphery/src/libraries/Actions.sol";
import {TickMath} from "../../lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../lib/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPositionManager} from "../../lib/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "../../lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IBTCVaultSwap} from "../../lib/contracts/src/applications/aave/interfaces/IBTCVaultSwap.sol";
import {AaveAdapter} from "../../lib/contracts/src/applications/aave/AaveAdapter.sol";
import {IAaveOracle} from "../../lib/contracts/lib/aave-v4/src/spoke/interfaces/IAaveOracle.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../src/LiquidationRouter.sol";
import {UniswapV4SwapVenue} from "../../src/WrappedVenue/UniswapV4SwapVenue.sol";
import {TBVHelper} from "./base/TBVHelper.sol";
import {console} from "forge-std/console.sol";

contract UniswapV4FlashSwapTest is Test, UniswapV4Base, TBVHelper {
    address internal ADMIN = vm.addr(69420);

    function setUp() public {
        vm.deal(ADMIN, 100 ether);
    }

    function test_UNISWAPV4_LIQUIDATION_TESTALL() external {
        for (uint256 i = 0; i < LIQUIDATION_TESTS.length; i++) {
            Types.TestParams memory params = LIQUIDATION_TESTS[i];
            vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

            address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());

            deal(wbtc, MORPHO_BLUE, 2 ** 96);
            _setUpUniswap(
                params.tbvContracts.debtTokens,
                _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
                wbtc
            );

            PoolKey[] memory poolKeys = _getPoolKeys();

            (LiquidationRouter router, UniswapV4SwapVenue venue) =
                _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

            // Init liquidation calldata
            LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](3);
            flashDatas[0] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: params.tbvContracts.debtTokens[0],
                swapData: abi.encode(poolKeys[0])
            });
            flashDatas[1] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: params.tbvContracts.debtTokens[1],
                swapData: abi.encode(poolKeys[1])
            });
            flashDatas[2] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.Morpho,
                venueAddress: MORPHO_BLUE,
                token: wbtc,
                swapData: abi.encode()
            });

            uint256 balanceWbtcBefore = IERC20(wbtc).balanceOf(params.liquidation.borrower);

            vm.prank(ADMIN);
            router.liquidate(
                LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
                flashDatas,
                new LiquidationTypes.SwapData[](0)
            );

            if (params.liquidation.hasFairnessPayment) {
                uint256 balanceWbtcAfter = IERC20(wbtc).balanceOf(params.liquidation.borrower);
                vm.assertGt(balanceWbtcAfter, balanceWbtcBefore, "Expected WBTC balance to increase after liquidation");
            }
        }
    }

    function test_UNISWAPV4_LIQUIDATION_TEST0() external {
        Types.TestParams memory params = LIQUIDATION_TESTS[0];
        vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

        address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());

        _setUpUniswap(
            params.tbvContracts.debtTokens,
            _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
            wbtc
        );

        PoolKey[] memory poolKeys = _getPoolKeys();

        (LiquidationRouter router, UniswapV4SwapVenue venue) =
            _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

        // Init liquidation calldata
        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        flashDatas[0] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: params.tbvContracts.debtTokens[0],
            swapData: abi.encode(poolKeys[0])
        });
        flashDatas[1] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: params.tbvContracts.debtTokens[1],
            swapData: abi.encode(poolKeys[1])
        });

        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(
            router.liquidate.selector,
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: type(uint256).max}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        // Run the revert test to gain insight into the liquidation process and the expected WBTC profit before payment
        vm.prank(ADMIN);
        (bool[] memory successes, bytes[] memory results) = router.multicall(datas, false);

        vm.assertFalse(successes[0], "Expected liquidation to fail due to BelovedError()");

        bytes memory truncData = new bytes(results[0].length - 4);
        for (uint256 i = 0; i < truncData.length; i++) {
            truncData[i] = results[0][i + 4];
        }

        (uint256 netWbtcBeforePayment, LiquidationTypes.VenueDebt[] memory venueDebts) =
            abi.decode(truncData, (uint256, LiquidationTypes.VenueDebt[]));
        uint256 sumVenueDebts = 0;

        for (uint256 i = 0; i < venueDebts.length; i++) {
            sumVenueDebts += venueDebts[i].amount;
        }

        vm.assertGt(
            netWbtcBeforePayment,
            sumVenueDebts,
            "Expected net WBTC before payment to be greater than sum of venue debts"
        );

        // Execute the liquidation
        vm.prank(ADMIN);
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        vm.assertEq(
            IERC20(wbtc).balanceOf(ADMIN),
            netWbtcBeforePayment - sumVenueDebts,
            "Expected final WBTC balance to match net WBTC before payment minus sum of venue debts"
        );
    }

    function _setUpRouter(address _lens, address _btcVaultSwap)
        internal
        returns (LiquidationRouter router, UniswapV4SwapVenue venue)
    {
        router = new LiquidationRouter(ADMIN, _lens, _btcVaultSwap);
        venue = new UniswapV4SwapVenue(UNISWAP_V4_POOL_MANAGER, address(router));
    }
}

