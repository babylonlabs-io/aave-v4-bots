// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

import {Types} from "./types.sol";
import {TestSuits} from "./testcases/testsuits.sol";
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
import {console} from "forge-std/console.sol";

contract UniswapV4FlashSwapTest is Test, TestSuits {
    address internal ADMIN = vm.addr(69420);

    address[] internal debtTokens = [
        address(0xB588C1bd8A6cd3F114A52a0AD916778B419ECf48), // USDC
        address(0xCFf21358114814258635524588f74521762A6c04)
        // , // USDT
        // address(0x7f780b992a401fcf61eD2fbE5c98bE914A611Db2) // DAI
    ];

    function setUp() public {
        vm.deal(ADMIN, 100 ether);
    }

    function test_UNISWAPV4_FLASH_SWAP_TEST0() external {
        Types.UniswapFlashSwapTestCaseParams memory params = UNISWAPV4_FLASH_SWAP_TEST0;
        vm.createSelectFork(vm.rpcUrl("sepolia"), params.liquidation.blockNumber);

        address oracle = AaveAdapter(params.tbvContracts.aaveAdapter).BTC_VAULT_CORE_SPOKE().ORACLE();
        uint256 btcPrice =
            IAaveOracle(oracle).getReservePrice(AaveAdapter(params.tbvContracts.aaveAdapter).VAULT_BTC_RESERVE_ID());

        PoolKey[] memory poolKeys =
            _setUpUniswap(address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC()), btcPrice);

        (LiquidationRouter router, UniswapV4SwapVenue venue) =
            _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        flashDatas[0] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: debtTokens[0],
            swapData: abi.encode(poolKeys[0])
        });
        flashDatas[1] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: debtTokens[1],
            swapData: abi.encode(poolKeys[1])
        });

        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(
                router.liquidate.selector,
                LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: type(uint256).max}),
                flashDatas,
                new LiquidationTypes.SwapData[](0)
            );
        vm.prank(ADMIN);
        (bool[] memory successes, bytes[] memory results) = router.multicall(datas, false);

        vm.assertFalse(successes[0], "Expected liquidation to fail due to BelovedError()");


        bytes memory truncData = new bytes(results[0].length - 4);
        for (uint256 i = 0; i < truncData.length; i++) {
            truncData[i] = results[0][i + 4];
        }

        (uint256 netWbtcBeforePayment, LiquidationTypes.VenueDebt[] memory venueDebts) = abi.decode(truncData, (uint256, LiquidationTypes.VenueDebt[]));
        uint256 sumVenueDebts = 0;

        for(uint256 i = 0; i < venueDebts.length; i++) {
            sumVenueDebts += venueDebts[i].amount;
        }

        vm.assertGt(netWbtcBeforePayment, sumVenueDebts, "Expected net WBTC before payment to be greater than sum of venue debts");

        vm.prank(ADMIN);
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );
    }

    function _setUpRouter(address _lens, address _btcVaultSwap)
        internal
        returns (LiquidationRouter router, UniswapV4SwapVenue venue)
    {
        router = new LiquidationRouter(ADMIN, _lens, _btcVaultSwap);
        venue = new UniswapV4SwapVenue(UNISWAP_V4_POOL_MANAGER, address(router));
    }

    function _setUpUniswap(address wbtc, uint256 wbtcPrice1e8) internal returns (PoolKey[] memory poolKeys) {
        poolKeys = new PoolKey[](debtTokens.length);
        for (uint256 i = 0; i < debtTokens.length; i++) {
            uint256 debtDecimals = IERC20Metadata(debtTokens[i]).decimals();
            (address c0, address c1) = wbtc < debtTokens[i] ? (wbtc, debtTokens[i]) : (debtTokens[i], wbtc);

            uint160 initialSqrtPriceX96;
            if (c0 == wbtc) {
                initialSqrtPriceX96 = encodeSqrtRatioX96(wbtcPrice1e8 * 10 ** debtDecimals / 1e8, 1e8);
            } else {
                initialSqrtPriceX96 = encodeSqrtRatioX96(1e8, wbtcPrice1e8 * 10 ** debtDecimals / 1e8);
            }

            PoolKey memory poolKey = PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: 3000,
                tickSpacing: 60,
                hooks: IHooks(address(0))
            });
            poolKeys[i] = poolKey;

            uint256 amountWbtc = 100 * 10 ** IERC20Metadata(wbtc).decimals();
            uint256 amountDebt = wbtcPrice1e8 / 1e8 * 100 * 10 ** debtDecimals;

            deal(wbtc, ADMIN, amountWbtc); // 100 wBTC
            deal(debtTokens[i], ADMIN, amountDebt);

            bytes[] memory params = new bytes[](2);
            params[0] =
                abi.encodeWithSelector(IPoolInitializer_v4.initializePool.selector, poolKey, initialSqrtPriceX96);

            bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));

            bytes[] memory mintParams = new bytes[](2);
            int24 tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
            int24 tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);

            uint256 liquidity = LiquidityAmounts.getLiquidityForAmounts(
                initialSqrtPriceX96,
                TickMath.getSqrtPriceAtTick(int24(tickLower)),
                TickMath.getSqrtPriceAtTick(int24(tickUpper)),
                c0 == wbtc ? amountWbtc : amountDebt,
                c0 == wbtc ? amountDebt : amountWbtc
            );

            mintParams[0] = abi.encode(
                poolKey,
                TickMath.minUsableTick(poolKey.tickSpacing),
                TickMath.maxUsableTick(poolKey.tickSpacing),
                liquidity,
                c0 == wbtc ? amountWbtc : amountDebt,
                c0 == wbtc ? amountDebt : amountWbtc,
                ADMIN,
                abi.encode()
            );

            mintParams[1] = abi.encode(c0, c1);
            params[1] = abi.encodeWithSelector(
                IPositionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), type(uint256).max
            );

            vm.startPrank(ADMIN);
            IERC20(c0).approve(UNISWAP_V4_PERMIT2, type(uint256).max);
            IERC20(c1).approve(UNISWAP_V4_PERMIT2, type(uint256).max);
            IAllowanceTransfer(UNISWAP_V4_PERMIT2)
                .approve(c0, UNISWAP_V4_POSITION_MANAGER, type(uint160).max, type(uint48).max);
            IAllowanceTransfer(UNISWAP_V4_PERMIT2)
                .approve(c1, UNISWAP_V4_POSITION_MANAGER, type(uint160).max, type(uint48).max);

            IPositionManager(UNISWAP_V4_POSITION_MANAGER).multicall(params);
            vm.stopPrank();
        }
    }

    function encodeSqrtRatioX96(uint256 amount1, uint256 amount0) internal pure returns (uint160 sqrtPriceX96) {
        require(amount0 > 0, "PriceMath: division by zero");
        // Multiply amount1 by 2^192 (left shift by 192) to preserve precision after the square root.
        uint256 ratioX192 = (amount1 << 192) / amount0;
        uint256 sqrtRatio = Math.sqrt(ratioX192);
        require(sqrtRatio <= type(uint160).max, "PriceMath: sqrt overflow");
        sqrtPriceX96 = uint160(sqrtRatio);
    }
}

