// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TransientSlotLib} from "../lib/TransientSlotLib.sol";

abstract contract ExpectCallback {
    using TransientSlotLib for bytes32;

    bytes32 private constant EXPECT_CALLBACK_TK = keccak256("ExpectCallback.expected");

    modifier consumeCallback(address caller) {
        _consumeCallback(caller);
        _;
    }

    function _expectCallback(address from) internal {
        require(from != address(0), "ExpectCallback: Invalid from address");
        require(EXPECT_CALLBACK_TK.loadAddress() == address(0), "ExpectCallback: Invalid State");
        EXPECT_CALLBACK_TK.storeAddress(from);
    }

    function _consumeCallback(address caller) internal {
        address expected = EXPECT_CALLBACK_TK.loadAddress();
        require(expected != address(0), "ExpectCallback: Invalid State");
        require(expected == caller, "ExpectCallback: Invalid Callback");
        EXPECT_CALLBACK_TK.storeAddress(address(0));
    }

    function _requireCompleteCallback() internal view {
        require(EXPECT_CALLBACK_TK.loadAddress() == address(0), "ExpectCallback: Callback not completed");
    }
}
