// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

interface ISwapVenue {
    function setUp(bytes calldata data) external;

    function flashLoan(
        address outToken, // token to receive
        uint256 amount, // amount to borrow
        bytes calldata data // details about the flash swap pair
    )
        external;
}
