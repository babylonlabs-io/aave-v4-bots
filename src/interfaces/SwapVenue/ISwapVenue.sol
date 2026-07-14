// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

/// @notice A dex wrapped so that a VenueManager can flash-borrow from it: take a token now, repay in another token
///         before the call ends.
/// @dev Implementations are expected to call `ISwapVenueCallback` back on the VenueManager — `onSetUpCallback` from
///      `setUp` and `onSwapVenueFlashSwap` from `flashSwap` — and to pull their repayment out of the VenueManager,
///      which approves it inside that callback.
interface ISwapVenue {
    /// @notice Whether `setUp` still has to be called before this venue can flash swap.
    /// @dev Not constant: a venue may need setup once per transaction (e.g. unlocking a pool manager) and report
    ///      false for the rest of it.
    function requireSetup() external view returns (bool);

    /// @notice Prepares the venue for flash swaps, calling `onSetUpCallback` on the caller to continue its flow.
    /// @dev Whatever the venue has to enter in order to swap (a UniswapV4 unlock, say) stays entered for the duration
    ///      of the callback, so this call only returns once the caller's whole flow has finished.
    /// @param data Caller state, passed back verbatim in `onSetUpCallback`.
    function setUp(bytes calldata data) external;

    /// @notice Flash-borrows `amount` of `outToken`, calls `onSwapVenueFlashSwap` on the caller, then takes repayment
    ///         in the pool's other token.
    /// @param outToken The token to receive.
    /// @param amount The exact amount to borrow.
    /// @param swapData Venue-specific route (e.g. the encoded pool to swap through).
    /// @param forwardData Caller state, passed back verbatim in `onSwapVenueFlashSwap`.
    function flashSwap(address outToken, uint256 amount, bytes calldata swapData, bytes calldata forwardData) external;
}
