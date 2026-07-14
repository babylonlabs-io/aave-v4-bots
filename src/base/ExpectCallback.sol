// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TransientSlotLib} from "../lib/TransientSlotLib.sol";

/// @notice Guards re-entrant callbacks (flash loans, flash swaps, pool manager unlocks) so that a callback
///         entrypoint can only be entered while the contract itself is waiting for it.
/// @dev    Usage:
///         - Before making the external call that triggers the callback, arm the guard with `_expectCallback`,
///           passing the selector of the callback function and the address expected to call it back.
///         - Mark the callback entrypoint with `consumeCallback`. It reverts unless `msg.sig` and `msg.sender`
///           match what was armed, then disarms the guard.
///         - After the external call returns, assert the callback actually happened with `_requireCompleteCallback`.
///
///         The expectation lives in a single transient slot, so at most one callback can be expected at a time:
///         arming a second one while another is pending reverts. Expectations do not survive the transaction,
///         so an armed-but-unconsumed slot cannot leak into a later transaction.
abstract contract ExpectCallback {
    using TransientSlotLib for bytes32;

    /// @dev Transient slot holding the packed `(caller, selector)` pair of the pending callback, or zero if none.
    bytes32 private constant EXPECT_CALLBACK_TK = keccak256("ExpectCallback.expected");

    /// @notice Restricts a callback entrypoint to the caller and selector armed by `_expectCallback`.
    modifier consumeCallback() {
        _consumeCallback();
        _;
    }

    /// @notice Arms the guard for a single upcoming callback.
    /// @dev Reverts if a callback is already expected, i.e. callbacks cannot be nested.
    /// @param selector The selector of the callback function that is expected to be called.
    /// @param from The address expected to make the callback (the venue / pool being called into).
    function _expectCallback(bytes4 selector, address from) internal {
        require(from != address(0), "ExpectCallback: Invalid from address");
        require(EXPECT_CALLBACK_TK.loadBytes32() == bytes32(0), "ExpectCallback: Invalid State");
        EXPECT_CALLBACK_TK.storeBytes32(_encodeExpectedCallback(selector, from));
    }

    /// @notice Checks the current call against the armed expectation and disarms the guard.
    /// @dev Reverts if no callback is expected, or if `msg.sig` / `msg.sender` do not match the expectation.
    function _consumeCallback() internal {
        bytes32 expectedBytes32 = EXPECT_CALLBACK_TK.loadBytes32();
        require(expectedBytes32 != bytes32(0), "ExpectCallback: Invalid State");

        (bytes4 expectedSelector, address expectedCaller) = _decodeExpectedCallback(expectedBytes32);
        require(expectedSelector == msg.sig, "ExpectCallback: Invalid signature");
        require(expectedCaller == msg.sender, "ExpectCallback: Invalid caller");

        EXPECT_CALLBACK_TK.storeBytes32(bytes32(0));
    }

    /// @dev Packs the expectation into one word: `from` in the upper 160 bits, `selector` in the lower 32.
    ///      The packed value is never zero for a valid expectation because `from` is non-zero.
    function _encodeExpectedCallback(bytes4 selector, address from) private pure returns (bytes32 expectedBytes32) {
        return bytes32(uint256(uint160(from)) << 32 | uint256(uint32(selector)));
    }

    /// @dev Inverse of `_encodeExpectedCallback`.
    function _decodeExpectedCallback(bytes32 expectedBytes32) private pure returns (bytes4 selector, address from) {
        selector = bytes4(uint32(uint256(expectedBytes32)));
        from = address(uint160(uint256(expectedBytes32) >> 32));
    }

    /// @notice Asserts that no callback is still pending.
    /// @dev Call after the external call that was supposed to trigger the callback, to catch a venue that
    ///      silently skipped it.
    function _requireCompleteCallback() internal view {
        require(EXPECT_CALLBACK_TK.loadBytes32() == bytes32(0), "ExpectCallback: Callback not completed");
    }
}
