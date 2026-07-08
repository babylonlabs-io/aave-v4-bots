// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {TransientSlotLib} from "./TransientSlotLib.sol";

type ArrayKey is bytes32;

library TransientArrayLib {
    using TransientSlotLib for bytes32;
    using TransientArrayLib for ArrayKey;

    function len(ArrayKey key) internal view returns (uint256) {
        return ArrayKey.unwrap(key).loadUint256();
    }

    function append(ArrayKey key, bytes32 value) internal {
        uint256 length = key.len();
        getIndexSlot(key, length).storeBytes32(value);
        ArrayKey.unwrap(key).storeUint256(length + 1);
    }

    function contains(ArrayKey key, bytes32 value) internal view returns (bool) {
        uint256 length = key.len();
        for (uint256 i = 0; i < length; i++) {
            if (getIndexSlot(key, i).loadBytes32() == value) {
                return true;
            }
        }
        return false;
    }

    function getIndexSlot(ArrayKey key, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(ArrayKey.unwrap(key), "[", index, "]"));
    }

    function at(ArrayKey key, uint256 index) internal view returns (bytes32) {
        require(index < key.len(), "Index out of bounds");
        return getIndexSlot(key, index).loadBytes32();
    }

    function clear(ArrayKey key) internal {
        uint256 length = key.len();
        for (uint256 i = 0; i < length; i++) {
            getIndexSlot(key, i).storeBytes32(bytes32(0));
        }
        ArrayKey.unwrap(key).storeUint256(0);
    }
}

