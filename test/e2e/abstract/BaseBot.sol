// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseE2E} from "test-e2e-base/BaseE2E.sol";

/// @title BaseBot
/// @notice Adds live-RPC read helpers to BaseE2E for bot E2E scripts.
/// @dev Forge broadcast scripts cache forked storage in their local EVM, so
///      `contract.fn()` reads inside polling loops keep returning the value
///      observed at the start of the script — they never see state changes
///      produced by external actors (the bot under test). Routing reads
///      through `cast call` via FFI bypasses that cache and returns whatever
///      the live node reports right now. Scripts that inherit BaseBot must
///      be invoked with `--ffi`.
abstract contract BaseBot is BaseE2E {
    /// @notice Default RPC endpoint matching the value used by the e2e workflow's `forge script` invocations.
    string internal constant _DEFAULT_RPC_URL = "http://127.0.0.1:8545";

    /// @notice Calls a contract via `cast call` and returns the raw ABI-encoded result for `abi.decode`.
    /// @param target Contract address to call.
    /// @param func Solidity-style function signature, e.g. `"balanceOf(address)"`.
    /// @param params String-encoded arguments in the order expected by `cast`.
    function ffi_castCall(address target, string memory func, string[] memory params) internal returns (bytes memory) {
        string memory rpcUrl = _vm.envOr("E2E_RPC_URL", _DEFAULT_RPC_URL);

        string[] memory cmd = new string[](6 + params.length);
        cmd[0] = "cast";
        cmd[1] = "call";
        cmd[2] = "--rpc-url";
        cmd[3] = rpcUrl;
        cmd[4] = _vm.toString(target);
        cmd[5] = func;
        for (uint256 i = 0; i < params.length; i++) {
            cmd[6 + i] = params[i];
        }

        return _vm.ffi(cmd);
    }
}
