// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {BaseE2E} from "test-e2e-base/BaseE2E.sol";

abstract contract BaseBot is BaseE2E {
    function ffi_castCall(address target, string memory func, string[] memory params) internal returns (bytes memory) {
        // Construct the command to call cast with the target, function, and parameters
        string[] memory cmd = new string[](6 + params.length);
        cmd[0] = "cast";
        cmd[1] = "call";
        cmd[2] = "--rpc-url";
        cmd[3] = "http://localhost:8545";
        cmd[4] = _vm.toString(target);
        cmd[5] = func;
        for (uint256 i = 0; i < params.length; i++) {
            cmd[6 + i] = params[i];
        }

        return _vm.ffi(cmd);
    }

    function _submitBatchedInclusionProofs(bytes32[] memory vaultIds) internal {}
}
