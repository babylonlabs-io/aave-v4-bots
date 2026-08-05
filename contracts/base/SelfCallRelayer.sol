// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SelfCallRelayer
/// @notice Base contract that lets an off-chain signer authorize a batch of calls the contract makes
///         to itself, while allowing anyone to pay the gas to submit them.
/// @dev Execution model: `relay` verifies one EIP-712 signature over the whole batch, then executes each
///      `Call` as `address(this).call(...)`. Because the caller of each inner call is the contract itself,
///      privileged entrypoints in derived contracts can be gated with {onlySelf}, and the batch signature
///      becomes the single authorization for all of them.
///
///      Trust model — read before deriving from this contract:
///
///      - `signer` is the only authority. It is set once in the constructor and cannot be rotated; there is
///        no owner and no pause. Recovering from a signer-key compromise requires deploying a new instance
///        and revoking whatever approvals or roles the old instance was granted.
///      - {onlySelf} is not an authorization boundary of its own. It only proves the call arrived through
///        `relay`, which means it proves the signer authorized it — nothing more.
///      - Signed messages carry no nonce and are not bound to a submitter, so a message stays replayable by
///        anyone until its `deadline`. This is deliberate: the signature attests that the signer considered
///        the action valid, and derived contracts are expected to relay only actions that are naturally
///        non-repeatable (the target state is consumed) or economically neutral when repeated. Derived
///        contracts whose actions do not have that property must add their own replay protection.
///      - `deadline` has no upper bound. Signing `type(uint256).max` creates a standing authorization.
///
///      EIP-712: the digest follows the spec exactly, so `signTypedData` from any standard wallet or client
///      library produces accepted signatures. Signatures are recovered with ECDSA only; contract signers
///      (ERC-1271) are not supported.
abstract contract SelfCallRelayer is EIP712 {
    /// @notice A single call the contract makes to itself during a relayed batch.
    struct Call {
        bytes data; // ABI-encoded calldata; must be at least 4 bytes (a function selector)
        uint256 value; // Wei forwarded with the call, drawn from this contract's balance
    }

    /// @notice A batch of self-calls authorized by one signature.
    struct RelayerMessage {
        Call[] calls; // Executed in order; any failure reverts the whole batch
        uint256 deadline; // Last block timestamp at which the batch may execute (inclusive)
    }

    /// @notice EIP-712 type hash for {Call}.
    bytes32 public constant CALL_TYPEHASH = keccak256("Call(bytes data,uint256 value)");

    /// @notice EIP-712 type hash for {RelayerMessage}.
    /// @dev Referenced struct types follow the primary type in alphabetical order, per EIP-712 `encodeType`.
    bytes32 public constant RELAYER_MESSAGE_TYPEHASH =
        keccak256("RelayerMessage(Call[] calls,uint256 deadline)Call(bytes data,uint256 value)");

    /// @notice Emitted once per successfully executed batch.
    /// @param executor Address that submitted the batch and paid its gas; unrelated to `signer`
    /// @param timestamp Block timestamp at execution
    /// @param message The batch that was executed
    event RelayerMessageExecuted(address indexed executor, uint256 indexed timestamp, RelayerMessage message);

    /// @notice Address whose ECDSA signature authorizes relayed batches. Immutable; cannot be rotated.
    address public immutable signer;

    /// @notice Restricts a function to calls originating from {relay}.
    /// @dev Equivalent to requiring that `signer` authorized this call in a relayed batch.
    modifier onlySelf() {
        require(msg.sender == address(this), "SelfCallRelayer: unauthorized");
        _;
    }

    /// @param _signer Address whose signature authorizes relayed batches. Must be non-zero.
    constructor(address _signer) {
        require(_signer != address(0), "SelfCallRelayer: invalid signer");
        signer = _signer;
    }

    /// @notice Executes a signer-authorized batch of self-calls.
    /// @dev Permissionless: anyone holding a valid `(message, signature)` pair may submit it, and both are
    ///      public once the transaction is broadcast. The batch is atomic — the first failing call reverts
    ///      everything, bubbling up the callee's original revert data.
    ///
    ///      Each call's `data` must be at least 4 bytes; shorter calldata reverts with a panic on the
    ///      selector slice below.
    ///
    ///      The selector check rejects a batch that calls `relay` on this contract directly. It is a
    ///      guard against pointless self-nesting, not reentrancy protection: it does not stop a contract
    ///      called during the batch from calling `relay` back with the same signature.
    ///
    ///      This function is `payable`, but every inner call targets `address(this)`, so any `call.value`
    ///      is only ever moved from this contract to itself. There is no withdrawal path, so `msg.value`
    ///      sent here is not recoverable. Submit with zero value.
    /// @param message The batch to execute
    /// @param signature ECDSA signature by `signer` over the EIP-712 digest of `message`
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

    /// @dev Reverts unless `message` is unexpired and `signature` recovers to `signer`.
    /// @param message The batch being authorized
    /// @param signature ECDSA signature over the EIP-712 digest of `message`
    function _verifyRelayerMessage(RelayerMessage memory message, bytes calldata signature) internal view {
        require(block.timestamp <= message.deadline, "SelfCallRelayer: expired");
        bytes32 digest = _hashRelayerMessage_signing(message);
        address recoveredSigner = ECDSA.recover(digest, signature);
        require(recoveredSigner == signer, "SelfCallRelayer: invalid signature");
    }

    /// @dev Builds the EIP-712 digest to sign: `keccak256(0x1901 ++ domainSeparator ++ hashStruct(message))`.
    ///      The `Call[]` member is encoded as the keccak256 of its concatenated element hashes, per EIP-712.
    /// @param message The batch to hash
    /// @return The digest a wallet signs for this message and this contract
    function _hashRelayerMessage_signing(RelayerMessage memory message) internal view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](message.calls.length);
        for (uint256 i = 0; i < message.calls.length; i++) {
            callHashes[i] = _hashCall(message.calls[i]);
        }

        return _hashTypedDataV4(
            keccak256(abi.encode(RELAYER_MESSAGE_TYPEHASH, keccak256(abi.encodePacked(callHashes)), message.deadline))
        );
    }

    /// @dev EIP-712 `hashStruct` for a {Call}. `data` is a dynamic type, so its contents are hashed.
    /// @param call The call to hash
    /// @return The struct hash contributed by this call
    function _hashCall(Call memory call) internal pure returns (bytes32) {
        return keccak256(abi.encode(CALL_TYPEHASH, keccak256(call.data), call.value));
    }
}
