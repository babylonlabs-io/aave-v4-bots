// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library TransientSlotLib {
    function storeBytes32(bytes32 slot, bytes32 value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function loadBytes32(bytes32 slot) internal view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function storeAddress(bytes32 slot, address value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function loadAddress(bytes32 slot) internal view returns (address value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function storeUint256(bytes32 slot, uint256 value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function loadUint256(bytes32 slot) internal view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function loadBool(bytes32 slot) internal view returns (bool value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function storeBool(bytes32 slot, bool value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }
}
