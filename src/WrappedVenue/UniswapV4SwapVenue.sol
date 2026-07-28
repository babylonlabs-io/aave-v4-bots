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

/// @notice Adapts a UniswapV4 pool into the flash-loan shape `VenueManager` expects: borrow a token now, repay in a
///         different token by the end of the call.
/// @dev    UniswapV4 has no flash-loan entrypoint. What it has is a swap with deferred settlement: inside an unlocked
///         pool manager you may `take` the output token, do whatever you like, and only settle the input token before
///         the unlock ends. That is a flash swap, and this contract packages it as a venue:
///
///         1. `setUp` unlocks the pool manager. The unlock callback lands back in `VenueManager`, which keeps running
///            the caller's flow *inside* the unlock — everything below happens while the manager is unlocked.
///         2. `flashSwap` swaps for the requested output token, takes it straight to the VenueManager, and calls
///            `onSwapVenueFlashSwap` so the VenueManager can use the funds and record what it owes.
///         3. When control returns, this contract pulls the input token from the VenueManager (which approved it in
///            the callback) and settles it with the pool manager, closing the swap.
///
///         Unlocking and swapping are split because the pool manager can only be unlocked once, while a single
///         liquidation may draw from several venues.
contract UniswapV4SwapVenue is ISwapVenue, IUniswapV4UnlockCallback, ExpectCallback {
    using TransientSlotLib for bytes32;
    using SafeERC20 for IERC20;

    bytes private constant EMPTY_BYTES = abi.encode();

    bytes32 private constant HEADER = keccak256("UniswapV4SwapDataHeader");

    /// @dev The pool manager's transient `unlocked` slot, read via `exttload`. Hard-coded because UniswapV4 exposes no
    ///      getter for it.
    bytes32 private constant UNISWAP_V4_PM_IS_UNLOCKED_TK =
        0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;

    /// @notice The UniswapV4 pool manager this venue swaps against.
    address public immutable uniV4PoolManager;
    /// @notice The only contract allowed to drive this venue, and the counterparty of every flash swap.
    address public immutable venueManager;

    /// @notice Restricts a function to `venueManager`.
    modifier onlyVenueManager() {
        require(msg.sender == venueManager, "UniswapV4SwapVenue: Only venue manager can call this function");
        _;
    }

    /// @param _uniV4PoolManager The UniswapV4 pool manager.
    /// @param _venueManager The VenueManager that will use this venue.
    constructor(address _uniV4PoolManager, address _venueManager) {
        require(_uniV4PoolManager != address(0), "UniswapV4SwapVenue: Invalid pool manager address");
        require(_venueManager != address(0), "UniswapV4SwapVenue: Invalid venue manager address");
        uniV4PoolManager = _uniV4PoolManager;
        venueManager = _venueManager;
    }

    /// @inheritdoc ISwapVenue
    /// @dev Unlocks the pool manager. Note this does not return until the VenueManager's whole flow has run: the
    ///      unlock callback continues it, and only then does the unlock — and this call — finish.
    function setUp(bytes calldata forwardData) external onlyVenueManager {
        require(!isUnlocked(), "UniswapV4SwapVenue: Pool manager is already unlocked");
        _expectCallback(UniswapV4SwapVenue.unlockCallback.selector, uniV4PoolManager);
        IUniswapV4PoolManager(uniV4PoolManager).unlock(forwardData);
        _requireCompleteCallback();
    }

    /// @inheritdoc IUniswapV4UnlockCallback
    /// @dev Context:
    /// - msg.sender is now the pool manager (uniswap v4)
    /// - swapData = [HEADER, data]
    /// Hands control back to the VenueManager, so the rest of its flow — including any `flashSwap` on this venue —
    /// runs while the pool manager is unlocked. Guarded by `consumeCallback`: only the pool manager can enter it, and
    /// only while `setUp` is waiting.
    function unlockCallback(bytes calldata forwardData) external consumeCallback returns (bytes memory) {
        ISwapVenueCallback(venueManager).onSetUpCallback(msg.sender, forwardData);
        return abi.encode();
    }

    /// @inheritdoc ISwapVenue
    /// @dev Requires the pool manager to already be unlocked, i.e. this must run inside the `setUp` unlock callback.
    ///      The input token and the amount owed are decided by the pool: the caller asks for an exact `amountOut` and
    ///      finds out what it costs in `onSwapVenueFlashSwap`.
    /// @param tokenOut The token to borrow; must be one side of the pool.
    /// @param amountOut The exact amount to borrow.
    /// @param swapData The ABI-encoded `PoolKey` of the pool to swap through.
    /// @param forwardData Opaque VenueManager state, passed straight through to the callback.
    function flashSwap(address tokenOut, uint256 amountOut, bytes calldata swapData, bytes calldata forwardData)
        external
        onlyVenueManager
    {
        require(amountOut > 0, "UniswapV4SwapVenue: Amount out must be greater than zero");
        require(isUnlocked(), "UniswapV4SwapVenue: Pool manager is locked");

        PoolKey memory poolKey = abi.decode(swapData, (PoolKey));

        (address tokenIn, uint256 amountIn) = _swapAndTake(poolKey, tokenOut, amountOut, msg.sender);
        ISwapVenueCallback(msg.sender).onSwapVenueFlashSwap(tokenIn, amountIn, forwardData);

        IUniswapV4PoolManager(uniV4PoolManager).sync(Currency.wrap(tokenIn));
        IERC20(tokenIn).safeTransferFrom(msg.sender, uniV4PoolManager, amountIn);
        IUniswapV4PoolManager(uniV4PoolManager).settle();
    }

    /// @notice Swaps for an exact `amountOut` of `tokenOut` and sends it to `receiver`, leaving the input side unpaid.
    /// @dev Exact-output swap (positive `amountSpecified`) with the price limit set to the extreme tick, so the pool
    ///      fills the whole amount at whatever price it takes; slippage is bounded by the caller's own profit check,
    ///      not here. The output is `take`n rather than transferred, which is what leaves the input owed to the pool
    ///      manager until `settle`.
    /// @return tokenIn The other side of the pool: what must be paid back.
    /// @return amountIn How much of it the pool wants.
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

        require(amountActual == amountOut, "UniswapV4SwapVenue: Amount out mismatch");

        (tokenIn, amountIn) = zeroForOne
            ? (Currency.unwrap(poolKey.currency0), SafeCast.toUint128(-delta.amount0()))
            : (Currency.unwrap(poolKey.currency1), SafeCast.toUint128(-delta.amount1()));
    }

    /// @notice Whether the pool manager is currently unlocked, i.e. whether `flashSwap` can run.
    /// @dev Reads the pool manager's transient `unlocked` flag directly, since UniswapV4 exposes no getter for it.
    function isUnlocked() public view returns (bool unlocked) {
        bytes32 unlockedB32 = IUniswapV4PoolManager(uniV4PoolManager).exttload(UNISWAP_V4_PM_IS_UNLOCKED_TK);
        assembly ("memory-safe") {
            unlocked := unlockedB32
        }
    }

    /// @inheritdoc ISwapVenue
    /// @dev Setup is needed exactly when the pool manager is still locked; once another venue in the same transaction
    ///      has unlocked it, this venue is ready to swap as-is.
    function requireSetup() external view returns (bool) {
        return !isUnlocked();
    }
}
