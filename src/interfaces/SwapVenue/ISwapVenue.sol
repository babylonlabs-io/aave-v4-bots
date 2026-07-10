// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

interface ISwapVenue {
    function requireSetup() external view returns (bool);

    function setUp(bytes calldata data) external;

    function flashSwap(
        address outToken, // token to receive
        uint256 amount, // amount to borrow
        bytes calldata swapData, // data to determine swap route
        bytes calldata forwardData // data to forward to the swap router
    )
        external;
}
