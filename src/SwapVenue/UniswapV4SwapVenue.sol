// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapVenue} from "../interfaces/SwapVenue/ISwapVenue.sol";
import {ISwapVenueCallback} from "../interfaces/SwapVenue/ISwapVenueCallback.sol";
import {IUniswapV4PoolManager} from "../interfaces/UniswapV4/IUniswapV4PoolManager.sol";
import {IUniswapV4UnlockCallback} from "../interfaces/UniswapV4/IUniswapV4UnlockCallback.sol";
import {TransientSlotLib} from "../lib/TransientSlotLib.sol";
import {ExpectCallback} from "../base/ExpectCallback.sol";

contract UniswapV4SwapVenue is ISwapVenue, IUniswapV4UnlockCallback, ExpectCallback {
    using TransientSlotLib for bytes32;
    using SafeERC20 for IERC20;

    bytes32 private constant HEADER = keccak256("UniswapV4SwapData");
    string private constant UNISWAP_V4_UNLOCKED_PREFIX = "UniswapV4SwapVenue.unlocked";

    function setUp(address venue, bytes calldata data) external {
        require(!_getUnlockedSlot(venue).loadBool(), "UniswapV4SwapVenue: Pool manager is already unlocked");
        _expectCallback(venue);
        IUniswapV4PoolManager(venue).unlock(abi.encode(msg.sender, data));
    }

    /// @dev Context:
    /// - msg.sender is now the pool manager (uniswap v4)
    /// - swapData = [venueManager (setUp.msg.sender), data]
    function unlockCallback(bytes calldata swapData) external consumeCallback(msg.sender) returns (bytes memory) {
        _getUnlockedSlot(msg.sender).storeBool(true);
        (address venueManager, bytes memory data) = abi.decode(swapData, (address, bytes));

        ISwapVenueCallback(venueManager).onSetUpCallback(msg.sender, data);
        _getUnlockedSlot(msg.sender).storeBool(false);
        return abi.encode();
    }

    function flashLoan(address venue, address outToken, uint256 amount, bytes calldata data) external {
        require(_getUnlockedSlot(venue).loadBool(), "UniswapV4SwapVenue: Pool manager is locked");
        IUniswapV4PoolManager(venue).take(outToken, msg.sender, amount);
        ISwapVenueCallback(msg.sender).onSwapVenueFlashLoan(outToken, amount, data);

        IUniswapV4PoolManager(venue).sync(outToken);
        IERC20(outToken).safeTransferFrom(msg.sender, venue, amount);
        IUniswapV4PoolManager(venue).settle();
    }

    function _getUnlockedSlot(address venue) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(UNISWAP_V4_UNLOCKED_PREFIX, "[", venue, "]"));
    }

    function _encodeSwapData(bytes memory data) internal view returns (bytes memory) {
        return abi.encode(HEADER, msg.sender, data);
    }

    function _decodeSwapData(bytes memory swapData) internal pure returns (address, bytes memory) {
        (bytes32 header, address venueManager, bytes memory data) = abi.decode(swapData, (bytes32, address, bytes));
        require(header == HEADER, "UniswapV4SwapVenue: Invalid venue data");
        return (venueManager, data);
    }
}
