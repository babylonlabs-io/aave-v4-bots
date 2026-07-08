// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library VenueDataLib {
    bytes32 internal constant HEADER = keccak256("VenueData");

    function encodeMorpho(bytes memory data, address token) internal pure returns (bytes memory) {
        return abi.encode(HEADER, data, token);
    }

    function decodeMorpho(bytes memory venueData) internal pure returns (bytes memory data, address token) {
        (bytes32 header, bytes memory decodedData, address decodedToken) =
            abi.decode(venueData, (bytes32, bytes, address));
        require(header == HEADER, "VenueDataLib: Invalid venue data");
        return (decodedData, decodedToken);
    }

    function encodeStandard(bytes memory data) internal pure returns (bytes memory) {
        return abi.encode(HEADER, data);
    }

    function decodeStandard(bytes memory venueData) internal pure returns (bytes memory data) {
        (bytes32 header, bytes memory decodedData) = abi.decode(venueData, (bytes32, bytes));
        require(header == HEADER, "VenueDataLib: Invalid venue data");
        return decodedData;
    }
}
