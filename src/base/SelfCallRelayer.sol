// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {EIP712} from "../../lib/contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "../../lib/contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

abstract contract SelfCallRelayer is EIP712 {
    struct Call {
        bytes data;
        uint256 value;
    }

    struct RelayerMessage {
        Call[] calls;
        uint256 deadline;
    }

    bytes32 public constant CALL_TYPEHASH = keccak256("Call(bytes data,uint256 value)");
    bytes32 public constant RELAYER_MESSAGE_TYPEHASH =
        keccak256("RelayerMessage(Call[] calls,uint256 deadline)Call(bytes data,uint256 value)");

    event RelayerMessageExecuted(address indexed executor, uint256 indexed timestamp, RelayerMessage message);

    address public immutable signer;

    modifier onlySelf() {
        require(msg.sender == address(this), "SelfCallRelayer: unauthorized");
        _;
    }

    constructor(address _signer) {
        require(_signer != address(0), "SelfCallRelayer: invalid signer");
        signer = _signer;
    }

    function relay(RelayerMessage calldata message, bytes calldata signature) external payable {
        _verifyRelayerMessage(message, signature);
        for (uint256 i = 0; i < message.calls.length; i++) {
            Call calldata call = message.calls[i];
            require(bytes4(call.data[:4]) != this.relay.selector, "SelfCallRelayer: cannot call relay");

            (bool success, bytes memory returndata) = address(this).call{value: call.value}(call.data);
            if (!success) {
                if (returndata.length > 0) {
                    assembly {
                        let returndata_size := mload(returndata)
                        revert(add(32, returndata), returndata_size)
                    }
                } else {
                    revert("SelfCallRelayer: call failed");
                }
            }
        }
        emit RelayerMessageExecuted(msg.sender, block.timestamp, message);
    }

    function _verifyRelayerMessage(RelayerMessage memory message, bytes calldata signature) internal view {
        require(block.timestamp <= message.deadline, "SelfCallRelayer: expired");
        bytes32 digest = _hashRelayerMessage_signing(message);
        address recoveredSigner = ECDSA.recover(digest, signature);
        require(recoveredSigner == signer, "SelfCallRelayer: invalid signature");
    }

    function _hashRelayerMessage_signing(RelayerMessage memory message) internal view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](message.calls.length);
        for (uint256 i = 0; i < message.calls.length; i++) {
            callHashes[i] = _hashCall(message.calls[i]);
        }

        return _hashTypedDataV4(
            keccak256(abi.encode(RELAYER_MESSAGE_TYPEHASH, keccak256(abi.encodePacked(callHashes)), message.deadline))
        );
    }

    function _hashCall(Call memory call) internal pure returns (bytes32) {
        return keccak256(abi.encode(CALL_TYPEHASH, keccak256(call.data), call.value));
    }
}
