// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

interface ISwapVenueCallback {
    /// @notice Sets up the callback for the swap venue.
    /// @dev This function is called by the swap venue to set up the callback.
    /// @param venue The address of the swap venue.
    /// @param data The data passed to the `setUp` function of the swap venue.
    function onSetUpCallback(address venue, bytes calldata data) external;

    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param paymentToken The address of the token for repaying the flash swap.
    /// @param amount The amount of tokens for repaying the flash swap.
    /// @param data Arbitrary data passed to the `flashLoan` function.
    function onSwapVenueFlashSwap(address paymentToken, uint256 amount, bytes calldata data) external;
}
