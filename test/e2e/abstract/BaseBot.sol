// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {BTCVaultTypes} from "vault-contracts/lib/BTCVaultTypes.sol";
import {BaseE2E} from "test-e2e-base/BaseE2E.sol";
import {ArrayHelper} from "../lib/ArrayHelper.sol";

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

    /// @notice Assert the running bot's kill switch behaves, via `test/e2e/scripts/killswitch-check.sh`.
    /// @dev The only place the whole control-plane path is exercised in a real process: the token
    ///      resolved through the `repo/secrets` package, the control server bound to loopback on its own
    ///      socket, and — critically — the metrics port serving no control route at all. The
    ///      script exits non-zero on any failed assertion, which reverts this script.
    ///      Requires `--ffi`, and a cwd of the repo root (how CI and e2e-local.sh invoke forge).
    function _checkKillSwitch(uint256 controlPort, uint256 metricsPort, string memory token) internal {
        string[] memory cmd = new string[](5);
        cmd[0] = "bash";
        cmd[1] = "test/e2e/scripts/killswitch-check.sh";
        cmd[2] = _vm.toString(controlPort);
        cmd[3] = _vm.toString(metricsPort);
        cmd[4] = token;
        _vm.ffi(cmd);
    }

    /// @notice Canonical proxy for a user (matches the setup scripts).
    function _getUserProxyAddress(address user) internal view returns (address) {
        return aaveAdapter.getPosition(user).proxyContract;
    }

    /// @notice Read a borrower's live position (collateral, debt, health factor)
    ///         via FFI, so a polling loop sees changes the bot makes outside this
    ///         script's local EVM. `ISpoke.UserAccountData` is 7 uint256s:
    ///         (riskPremium, avgCollateralFactor, healthFactor,
    ///         totalCollateralValue, totalDebtValueRay, activeCollateralCount,
    ///         borrowCount).
    function _getPositionInfo(address user)
        internal
        returns (uint256 totalCollateral, uint256 totalDebt, uint256 healthFactor)
    {
        address proxy = _getUserProxyAddress(user);
        bytes memory result =
            ffi_castCall(address(aaveSpoke), "getUserAccountData(address)", ArrayHelper.create(_vm.toString(proxy)));
        (,, healthFactor, totalCollateral, totalDebt,,) =
            abi.decode(result, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    /// @notice ERC-20 balance of `token` for `user`, read live via FFI.
    function _erc20Balance(address token, address user) internal returns (uint256) {
        bytes memory result = ffi_castCall(token, "balanceOf(address)", ArrayHelper.create(_vm.toString(user)));
        return abi.decode(result, (uint256));
    }

    function _getWbtcBalance(address user) internal returns (uint256) {
        return _erc20Balance(address(wbtc), user);
    }

    function _getUsdcBalance(address user) internal returns (uint256) {
        return _erc20Balance(address(usdc), user);
    }

    /// @notice Read a uint written by a setup script (e.g. an initial-balance
    ///         snapshot). Uses `readFile`, not FFI, to avoid Foundry hex-decoding
    ///         all-digit output.
    function _readInitialBalance(string memory filename) internal view returns (uint256) {
        uint256 parsed = _vm.parseUint(_vm.readFile(filename));
        require(parsed > 0, "Missing initial balance from setup");
        return parsed;
    }

    /// @notice The vault ID a setup script recorded, or `bytes32(0)` when the file is absent.
    function _readVaultIdFromFile() internal view returns (bytes32) {
        try _vm.readFile(".e2e-vault-id") returns (string memory content) {
            return _vm.parseBytes32(content);
        } catch {
            return bytes32(0);
        }
    }

    /// @notice Whether a vault still sits escrowed in the VaultSwap awaiting a buyer. Once acquired
    ///         its status flips to Redeemed and this returns false — the proxy for "left escrow".
    function _isVaultAcquirable(bytes32 vaultId) internal returns (bool) {
        bytes memory result =
            ffi_castCall(address(vaultSwap), "isVaultAcquirable(bytes32)", ArrayHelper.create(_vm.toString(vaultId)));
        return abi.decode(result, (bool));
    }

    /// @notice A vault's status + amount. `getBtcVaultBasicInfo(bytes32)` returns the full
    ///         `BTCVaultBasicInfo { depositor, depositorBtcPubKey, amount, vaultProvider, status,
    ///         applicationEntryPoint, createdAt }` struct — all static members, so it ABI-encodes as
    ///         the same 7-element tuple, in field order. (The `btcVaultsBasicInfo` mapping is
    ///         `internal`; external reads go through this getter.)
    function _getVaultStatusAndAmount(bytes32 vaultId)
        internal
        returns (BTCVaultTypes.BTCVaultStatus status, uint256 amount)
    {
        bytes memory result = ffi_castCall(
            address(btcVaultRegistry), "getBtcVaultBasicInfo(bytes32)", ArrayHelper.create(_vm.toString(vaultId))
        );
        (,, amount,, status,,) =
            abi.decode(result, (address, bytes32, uint256, address, BTCVaultTypes.BTCVaultStatus, address, uint256));
    }

    /// @notice Poll `borrower`'s position until it is cleared, up to `timeoutSeconds`.
    function _waitForLiquidation(address borrower, uint256 timeoutSeconds) internal returns (bool liquidated) {
        for (uint256 elapsed = 0;; elapsed += 5) {
            (uint256 col, uint256 debt,) = _getPositionInfo(borrower);
            if (col == 0 && debt == 0) {
                console.log("Liquidation detected after", elapsed, "seconds");
                return true;
            }
            if (elapsed >= timeoutSeconds) return false;
            _vm.sleep(5000);
            console.log("Still waiting for liquidation...", elapsed + 5, "/", timeoutSeconds);
        }
    }

    /// @notice Poll until the vault is acquired, up to `timeoutSeconds`. Redeemed **or** no longer
    ///         acquirable both count: `swapWbtcForVault*` redeems atomically, so a vault that left
    ///         escrow was bought even if a status read races the redemption.
    function _waitForAcquisition(bytes32 vaultId, uint256 timeoutSeconds) internal returns (bool acquired) {
        for (uint256 elapsed = 0;; elapsed += 5) {
            (BTCVaultTypes.BTCVaultStatus status,) = _getVaultStatusAndAmount(vaultId);
            bool redeemed = status == BTCVaultTypes.BTCVaultStatus.Redeemed;
            bool acquirable = _isVaultAcquirable(vaultId);
            if (redeemed || !acquirable) {
                console.log("Acquisition detected after", elapsed, "seconds");
                console.log("  vault redeemed:", redeemed);
                console.log("  still acquirable (escrowed):", acquirable);
                return true;
            }
            if (elapsed >= timeoutSeconds) return false;
            _vm.sleep(5000);
            console.log("Still waiting for acquisition...", elapsed + 5, "/", timeoutSeconds);
        }
    }
}
