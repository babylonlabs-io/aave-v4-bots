// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TestSuits} from "./TestSuits.sol";
import {
    PoolKey,
    Currency,
    IHooks,
    IPoolManager
} from "../../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolInitializer_v4} from "../../../lib/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {Actions} from "../../../lib/v4-periphery/src/libraries/Actions.sol";
import {Commands} from "../../../lib/universal-router/contracts/libraries/Commands.sol";
import {IUniversalRouter} from "../../../lib/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {TickMath} from "../../../lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../../lib/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPositionManager} from "../../../lib/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "../../../lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Test} from "forge-std/Test.sol";
import {IV4Quoter} from "../../../lib/v4-periphery/src/interfaces/IV4Quoter.sol";
import {MockUniswapV4DexAggRouter} from "../../mocks/MockUniswapV4DexAggRouter.sol";
import {IV4Router} from "../../../lib/v4-periphery/src/interfaces/IV4Router.sol";
import {Types as LiquidationTypes} from "../../../src/LiquidationRouter.sol";
import {console} from "forge-std/console.sol";

struct QuoteParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
}

struct ExactOutputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    bytes hookData;
}

abstract contract UniswapV4Base is Test, TestSuits {
    PoolKey[] private _poolKeys;
    address private POOL_OWNER = vm.addr(uint256(keccak256("POOL_OWNER")));

    function _getPoolKeys() internal view returns (PoolKey[] memory) {
        return _poolKeys;
    }

    function _setUpUniswap(address[] memory debtTokens, uint256[] memory wbtcPricesAgainstDebtToken, address wbtc)
        internal
    {
        _poolKeys = new PoolKey[](debtTokens.length);
        for (uint256 i = 0; i < debtTokens.length; i++) {
            uint256 debtDecimals = IERC20Metadata(debtTokens[i]).decimals();
            uint256 wbtcPrice1e8 = wbtcPricesAgainstDebtToken[i];
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
            _poolKeys[i] = poolKey;

            uint256 amountWbtc = 100 * 10 ** IERC20Metadata(wbtc).decimals();
            uint256 amountDebt = wbtcPrice1e8 / 1e8 * 100 * 10 ** debtDecimals;

            deal(wbtc, POOL_OWNER, amountWbtc); // 100 wBTC
            deal(debtTokens[i], POOL_OWNER, amountDebt);

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
                POOL_OWNER,
                abi.encode()
            );

            mintParams[1] = abi.encode(c0, c1);
            params[1] = abi.encodeWithSelector(
                IPositionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), type(uint256).max
            );

            vm.startPrank(POOL_OWNER);
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

    function _quoteWbtcExactOut(PoolKey memory poolKey, address wbtc, uint256 amountOut)
        internal
        returns (uint256 amountIn)
    {
        bool zeroForOne = Currency.unwrap(poolKey.currency0) == wbtc;

        (, bytes memory rtn) = UNISWAP_V4_QUOTER.call(
            abi.encodeWithSelector(
                IV4Quoter.quoteExactOutputSingle.selector,
                QuoteParams({
                    poolKey: poolKey, zeroForOne: zeroForOne, exactAmount: uint128(amountOut), hookData: abi.encode()
                })
            )
        );

        (amountIn,) = abi.decode(rtn, (uint256, uint256));
    }

    function _encodeSwapWbtcExactDebtOut(PoolKey memory poolKey, address wbtc, uint256 amountOut)
        internal
        returns (LiquidationTypes.SwapData memory swapData)
    {
        swapData.dexAggRouter = address(new MockUniswapV4DexAggRouter(UNISWAP_V4_ROUTER, UNISWAP_V4_PERMIT2));
        uint256 amountWbtcIn = uint128(_quoteWbtcExactOut(poolKey, wbtc, amountOut));
        uint256 amountTokenOut = uint128(amountOut);

        bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        bytes[] memory inputs = new bytes[](1);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);

        params[0] = abi.encode(
            ExactOutputSingleParams({
                poolKey: poolKey,
                zeroForOne: Currency.unwrap(poolKey.currency0) == wbtc,
                amountOut: uint128(amountTokenOut),
                amountInMaximum: uint128(amountWbtcIn),
                hookData: abi.encode()
            })
        );

        params[1] = abi.encode(wbtc, amountWbtcIn);

        address tokenOut = Currency.unwrap(poolKey.currency0) == wbtc
            ? Currency.unwrap(poolKey.currency1)
            : Currency.unwrap(poolKey.currency0);
        params[2] = abi.encode(tokenOut, amountTokenOut);

        inputs[0] = abi.encode(actions, params);

        swapData.callData = abi.encodeWithSelector(
            MockUniswapV4DexAggRouter.approveThenCall.selector,
            wbtc,
            amountWbtcIn,
            tokenOut,
            abi.encodeWithSelector(IUniversalRouter.execute.selector, commands, inputs, type(uint256).max)
        );
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
