// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TransientSlotLib} from "../lib/TransientSlotLib.sol";

abstract contract ExpectCallback {
    using TransientSlotLib for bytes32;

    bytes32 private constant EXPECT_CALLBACK_TK = keccak256("ExpectCallback.expected");

    modifier consumeCallback() {
        _consumeCallback();
        _;
    }

    function _expectCallback(bytes4 selector, address from) internal {
        require(from != address(0), "ExpectCallback: Invalid from address");
        require(EXPECT_CALLBACK_TK.loadBytes32() == bytes32(0), "ExpectCallback: Invalid State");
        EXPECT_CALLBACK_TK.storeBytes32(_encodeExpectedCallback(selector, from));
    }

    function _consumeCallback() internal {
        bytes32 expectedBytes32 = EXPECT_CALLBACK_TK.loadBytes32();
        require(expectedBytes32 != bytes32(0), "ExpectCallback: Invalid State");

        (bytes4 expectedSelector, address expectedCaller) = _decodeExpectedCallback(expectedBytes32);
        require(expectedSelector == msg.sig, "ExpectCallback: Invalid signature");
        require(expectedCaller == msg.sender, "ExpectCallback: Invalid caller");

        EXPECT_CALLBACK_TK.storeBytes32(bytes32(0));
    }

    function _encodeExpectedCallback(bytes4 selector, address from) private pure returns (bytes32 expectedBytes32) {
        return bytes32(uint256(uint160(from)) << 32 | uint256(uint32(selector)));
    }

    function _decodeExpectedCallback(bytes32 expectedBytes32) private pure returns (bytes4 selector, address from) {
        selector = bytes4(uint32(uint256(expectedBytes32)));
        from = address(uint160(uint256(expectedBytes32) >> 32));
    }

    function _requireCompleteCallback() internal view {
        require(EXPECT_CALLBACK_TK.loadBytes32() == bytes32(0), "ExpectCallback: Callback not completed");
    }
}
