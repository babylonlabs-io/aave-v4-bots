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

    function setUp(bytes calldata data) external onlyVenueManager {
        require(!UNISWAP_V4_UNLOCKED_TK.loadBool(), "UniswapV4SwapVenue: Pool manager is already unlocked");
        _expectCallback(uniV4PoolManager);
        IUniswapV4PoolManager(uniV4PoolManager).unlock(_encodeSwapData(data));
        _requireCompleteCallback();
    }

    /// @dev Context:
    /// - msg.sender is now the pool manager (uniswap v4)
    /// - swapData = [HEADER, data]
    function unlockCallback(bytes calldata swapData) external consumeCallback(msg.sender) returns (bytes memory) {
        UNISWAP_V4_UNLOCKED_TK.storeBool(true);
        bytes memory data = _decodeSwapData(swapData);

        ISwapVenueCallback(venueManager).onSetUpCallback(msg.sender, data);
        UNISWAP_V4_UNLOCKED_TK.storeBool(false);
        return abi.encode();
    }

    function flashLoan(address outToken, uint256 amount, bytes calldata data) external onlyVenueManager {
        require(UNISWAP_V4_UNLOCKED_TK.loadBool(), "UniswapV4SwapVenue: Pool manager is locked");
        IUniswapV4PoolManager(uniV4PoolManager).take(outToken, msg.sender, amount);
        ISwapVenueCallback(msg.sender).onSwapVenueFlashLoan(outToken, amount, data);

        IUniswapV4PoolManager(uniV4PoolManager).sync(outToken);
        IERC20(outToken).safeTransferFrom(msg.sender, uniV4PoolManager, amount);
        IUniswapV4PoolManager(uniV4PoolManager).settle();
    }

    function _encodeSwapData(bytes memory data) internal pure returns (bytes memory) {
        return abi.encode(HEADER, data);
    }

    function _decodeSwapData(bytes memory swapData) internal pure returns (bytes memory) {
        (bytes32 header, bytes memory data) = abi.decode(swapData, (bytes32, bytes));
        require(header == HEADER, "UniswapV4SwapVenue: Invalid venue data");
        return data;
    }
}
