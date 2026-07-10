// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapVenue} from "../interfaces/SwapVenue/ISwapVenue.sol";
import {ISwapVenueCallback} from "../interfaces/SwapVenue/ISwapVenueCallback.sol";
import {IUniswapV4UnlockCallback} from "../interfaces/UniswapV4/IUniswapV4UnlockCallback.sol";
import {TransientSlotLib} from "../lib/TransientSlotLib.sol";
import {ExpectCallback} from "../base/ExpectCallback.sol";
import {
    PoolKey,
    Currency,
    BalanceDelta,
    IPoolManager as IUniswapV4PoolManager,
    SwapParams
} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "../../lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {SafeCast} from "../../lib/v4-periphery/lib/v4-core/src/libraries/SafeCast.sol";

contract UniswapV4SwapVenue is ISwapVenue, IUniswapV4UnlockCallback, ExpectCallback {
    using TransientSlotLib for bytes32;
    using SafeERC20 for IERC20;

    bytes private constant EMPTY_BYTES = abi.encode();

    bytes32 private constant HEADER = keccak256("UniswapV4SwapDataHeader");
    bytes32 private constant UNISWAP_V4_UNLOCKED_TK = keccak256("UniswapV4SwapVenue.unlocked");

    address public immutable uniV4PoolManager;
    address public immutable venueManager;

    modifier onlyVenueManager() {
        require(msg.sender == venueManager, "UniswapV4SwapVenue: Only venue manager can call this function");
        _;
    }

    constructor(address _uniV4PoolManager, address _venueManager) {
        require(_uniV4PoolManager != address(0), "UniswapV4SwapVenue: Invalid pool manager address");
        require(_venueManager != address(0), "UniswapV4SwapVenue: Invalid venue manager address");
        uniV4PoolManager = _uniV4PoolManager;
        venueManager = _venueManager;
    }

    function setUp(bytes calldata forwardData) external onlyVenueManager {
        require(!UNISWAP_V4_UNLOCKED_TK.loadBool(), "UniswapV4SwapVenue: Pool manager is already unlocked");
        _expectCallback(uniV4PoolManager);
        IUniswapV4PoolManager(uniV4PoolManager).unlock(forwardData);
        _requireCompleteCallback();
    }

    /// @dev Context:
    /// - msg.sender is now the pool manager (uniswap v4)
    /// - swapData = [HEADER, data]
    function unlockCallback(bytes calldata forwardData) external consumeCallback(msg.sender) returns (bytes memory) {
        UNISWAP_V4_UNLOCKED_TK.storeBool(true);

        ISwapVenueCallback(venueManager).onSetUpCallback(msg.sender, forwardData);
        UNISWAP_V4_UNLOCKED_TK.storeBool(false);
        return abi.encode();
    }

    function flashSwap(address tokenOut, uint256 amountOut, bytes calldata swapData, bytes calldata forwardData)
        external
        onlyVenueManager
    {
        require (amountOut > 0, "UniswapV4SwapVenue: Amount out must be greater than zero");
        require(UNISWAP_V4_UNLOCKED_TK.loadBool(), "UniswapV4SwapVenue: Pool manager is locked");

        PoolKey memory poolKey = abi.decode(swapData, (PoolKey));

        (address tokenIn, uint256 amountIn) = _swapAndTake(poolKey, tokenOut, amountOut, msg.sender);
        ISwapVenueCallback(msg.sender).onSwapVenueFlashSwap(tokenIn, amountIn, forwardData);

        IUniswapV4PoolManager(uniV4PoolManager).sync(Currency.wrap(tokenIn));
        IERC20(tokenIn).safeTransferFrom(msg.sender, uniV4PoolManager, amountIn);
        IUniswapV4PoolManager(uniV4PoolManager).settle();
    }

    function _swapAndTake(PoolKey memory poolKey, address tokenOut, uint256 amountOut, address receiver)
        internal
        returns (address tokenIn, uint256 amountIn)
    {
        bool zeroForOne = tokenOut == Currency.unwrap(poolKey.currency1);
        BalanceDelta delta = IUniswapV4PoolManager(uniV4PoolManager)
            .swap(
                poolKey,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: int256(amountOut),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                EMPTY_BYTES
            );

        uint256 amountActual = SafeCast.toUint128(zeroForOne ? delta.amount1() : delta.amount0());
        IUniswapV4PoolManager(uniV4PoolManager).take(Currency.wrap(tokenOut), receiver, amountActual);

        (tokenIn, amountIn) = zeroForOne
            ? (Currency.unwrap(poolKey.currency0), SafeCast.toUint128(-delta.amount0()))
            : (Currency.unwrap(poolKey.currency1), SafeCast.toUint128(-delta.amount1()));
    }

    function requireSetup() external pure returns (bool) {
        return true;
    }
}
