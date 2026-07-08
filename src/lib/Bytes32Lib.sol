// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library Bytes32Lib {
    // TO BYTES32
    function toBytes32(uint256 value) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toBytes32(int256 value) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toBytes32(address value) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toBytes32(bool value) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    // FROM BYTES32
    function toUint256(bytes32 value) internal pure returns (uint256 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toInt256(bytes32 value) internal pure returns (int256 result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toAddress(bytes32 value) internal pure returns (address result) {
        assembly ("memory-safe") {
            result := value
        }
    }

    function toBool(bytes32 value) internal pure returns (bool result) {
        assembly ("memory-safe") {
            result := value
        }
    }
}
