// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title E2ESafe
/// @notice A faithful, minimal Safe{Wallet} **test double** for the MANUAL `safe`-custody e2e — NOT
///         the production Safe. It reproduces exactly the surface `operator-cli` signs against and the
///         bot's reconcile reads: the v1.4.1 EIP-712 SafeTx hash (`{chainId, verifyingContract}`
///         domain + the canonical `SafeTx` typehash), owner-signature verification (ascending order,
///         threshold, `ecrecover`), the `nonce`, `execTransaction`, and the `Execution*` events.
/// @dev Deliberately mirrors the real Safe's `GS013` rule: with `safeTxGas == 0 && gasPrice == 0`
///      (the operator-cli v1 policy) a failed inner call **reverts** `execTransaction` (status 0)
///      rather than emitting `ExecutionFailure` — so the bot's reconcile resolves an inner failure via
///      its status-0 branch, exactly as against a real Safe. The execution package's EIP-712 hash is
///      independently cross-checked against this canonical layout in a unit test.
contract E2ESafe {
    event ExecutionSuccess(bytes32 txHash, uint256 payment);
    event ExecutionFailure(bytes32 txHash, uint256 payment);

    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 private constant SAFE_TX_TYPEHASH = keccak256(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    );

    address[] private owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;
    uint256 public nonce;

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_threshold > 0 && _threshold <= _owners.length, "bad threshold");
        for (uint256 i; i < _owners.length; i++) {
            require(_owners[i] != address(0) && !isOwner[_owners[i]], "bad owner");
            isOwner[_owners[i]] = true;
        }
        owners = _owners;
        threshold = _threshold;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, address(this)));
    }

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) public view returns (bytes32) {
        bytes32 safeTxHash = keccak256(
            abi.encode(
                SAFE_TX_TYPEHASH,
                to,
                value,
                keccak256(data),
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                _nonce
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeTxHash));
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success) {
        require(operation == 0, "only CALL");
        bytes32 txHash = getTransactionHash(
            to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce
        );
        _checkSignatures(txHash, signatures);
        nonce++;

        (success,) = to.call{value: value}(data);
        // GS013: with no gas refund configured, a failed inner call reverts rather than emitting
        // ExecutionFailure — matching the real Safe under the operator-cli v1 zero-gas policy.
        require(success || safeTxGas != 0 || gasPrice != 0, "GS013");
        if (success) emit ExecutionSuccess(txHash, 0);
        else emit ExecutionFailure(txHash, 0);
    }

    function _checkSignatures(bytes32 dataHash, bytes calldata signatures) internal view {
        require(signatures.length >= threshold * 65, "sigs too short");
        address last = address(0);
        for (uint256 i = 0; i < threshold; i++) {
            (uint8 v, bytes32 r, bytes32 s) = _signatureSplit(signatures, i);
            address signer = ecrecover(dataHash, v, r, s);
            require(isOwner[signer], "not an owner");
            require(signer > last, "signatures not ascending / duplicate");
            last = signer;
        }
    }

    function _signatureSplit(bytes calldata signatures, uint256 i)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        assembly {
            let o := add(signatures.offset, mul(i, 65))
            r := calldataload(o)
            s := calldataload(add(o, 32))
            v := byte(0, calldataload(add(o, 64)))
        }
    }

    receive() external payable {}
}
