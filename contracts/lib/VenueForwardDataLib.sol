// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

/// @dev    VenueForwardDataLib is a library that provides functions for encoding and decoding venue forward data.
///         The library defines a constant HEADER that is used to identify the venue data.
///
///         All data passed into VenueManager will be encoded with a header to differentiate layers of encoding.
library VenueForwardDataLib {
    /// @dev Stamped on every payload leaving VenueManager. Its job is to make a forgery fail loudly: data arriving at
    ///      a callback without it was not encoded by this layer.
    bytes32 internal constant HEADER = keccak256("VenueDataHeader");

    /// @notice Morpho variant: carries the borrowed token alongside the payload.
    /// @dev Morpho's `onMorphoFlashLoan` callback is given the amount but not the token, so it has to be smuggled
    ///      through the data field. Every other venue names the token in its callback and uses the standard encoding.
    function encodeMorpho(bytes memory data, address token) internal pure returns (bytes memory) {
        return abi.encode(HEADER, data, token);
    }

    /// @notice Unwraps a Morpho payload, reverting if the header is missing.
    function decodeMorpho(bytes memory venueData) internal pure returns (bytes memory data, address token) {
        (bytes32 header, bytes memory decodedData, address decodedToken) =
            abi.decode(venueData, (bytes32, bytes, address));
        require(header == HEADER, "VenueDataLib: Invalid venue data");
        return (decodedData, decodedToken);
    }

    /// @notice Wraps a payload for any venue whose callback already names the token.
    function encodeStandard(bytes memory data) internal pure returns (bytes memory) {
        return abi.encode(HEADER, data);
    }

    /// @notice Unwraps a standard payload, reverting if the header is missing.
    function decodeStandard(bytes memory venueData) internal pure returns (bytes memory data) {
        (bytes32 header, bytes memory decodedData) = abi.decode(venueData, (bytes32, bytes));
        require(header == HEADER, "VenueDataLib: Invalid venue data");
        return decodedData;
    }
}
