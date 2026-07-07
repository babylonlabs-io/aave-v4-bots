// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BTCVaultTypes} from "vault-contracts/lib/BTCVaultTypes.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";
import {ArrayHelper} from "./lib/ArrayHelper.sol";

/// @title ArbitrageurE2EVerify
/// @notice E2E script to verify the arbitrageur bot acquired vaults from VaultSwap
/// @dev Part 3: Checks that the arbitrageur bot atomically acquired + redeemed the vault.
///      With the new atomic flow, swapWbtcForVault redeems internally, so the vault status
///      becomes Redeemed and the vault is no longer escrowed. We verify by comparing WBTC
///      balances against the known initial funding amounts from the setup script.
///      Run this AFTER LiquidationE2EVerify.s.sol.
///      Reads chain state via FFI `cast call` so the polling loop sees
///      the bot's transactions (forge's local EVM caches forked storage
///      and would otherwise show stale values).
contract ArbitrageurE2EVerify is Script, BaseBot {
    /// @notice Main entry point for the verification script
    function run() public {
        // Load deployed contracts
        init(vm);

        console.log("\n=== E2E Arbitrageur Verification (one bot, both engines) ===");

        bytes32 vaultId = _readVaultIdFromFile();
        require(vaultId != bytes32(0), "Missing vault ID from setup");
        uint256 arbInitialWbtc = _readInitialBalance(".e2e-initial-arb-wbtc");
        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);

        // ── Leg 1: liquidation (the bot's LiquidationEngine) ──────────────
        // Position-state only: the arb bot both liquidates and acquires, so its
        // WBTC delta (payout up, acquisition down) is entangled — the definitive
        // proof the liquidation ran is the cleared position.
        console.log("\n--- Leg 1: liquidation (position cleared) ---");
        bool positionLiquidated = _waitForLiquidation(borrower);
        require(positionLiquidated, "Position was not liquidated by the arb bot's LiquidationEngine");
        console.log("[PASS] Borrower position cleared (col == 0 && debt == 0)");

        // ── Leg 2: vault acquisition (the bot's ArbitrageEngine) ──────────
        console.log("\n--- Leg 2: vault acquisition ---");
        console.log("Vault ID:", vm.toString(vaultId));
        (bool vaultRedeemed, bool vaultEscrowed) = _waitForAcquisition(vaultId);

        uint256 arbWbtcNow = _getWbtcBalance(vm.envOr("E2E_ARB_ADDRESS", E2EConstants.ARBITRAGEUR));
        console.log("Arbitrageur WBTC now (sats):  ", arbWbtcNow);
        console.log("Arbitrageur WBTC initial (sats):", arbInitialWbtc);
        console.log("Is vault redeemed:", vaultRedeemed);
        console.log("Is vault still escrowed:", vaultEscrowed);

        bool acquired = vaultRedeemed || !vaultEscrowed;
        require(acquired, "Vault was not acquired by the arb bot's ArbitrageEngine");
        console.log("[PASS] Vault acquired (redeemed / left escrow)");

        console.log("\n=== E2E Arbitrageur Test PASSED (both engines) ===\n");
    }

    /// @dev Poll the live position until it is cleared, returning whether it was.
    function _waitForLiquidation(address borrower) internal returns (bool) {
        (uint256 col, uint256 debt,) = _getPositionInfo(borrower);
        if (col == 0 && debt == 0) return true;

        console.log("Polling every 5 seconds for up to 240 seconds...");
        uint256 elapsed = 0;
        while (elapsed < 240) {
            vm.sleep(5000);
            elapsed += 5;
            (col, debt,) = _getPositionInfo(borrower);
            if (col == 0 && debt == 0) {
                console.log("Liquidation detected after", elapsed, "seconds");
                return true;
            }
            console.log("Still waiting for liquidation...", elapsed, "/ 240");
        }
        return false;
    }

    /// @dev Poll the vault until redeemed or no longer escrowed.
    function _waitForAcquisition(bytes32 vaultId) internal returns (bool vaultRedeemed, bool vaultEscrowed) {
        (BTCVaultTypes.BTCVaultStatus status,) = _getVaultStatusAndAmount(vaultId);
        vaultRedeemed = status == BTCVaultTypes.BTCVaultStatus.Redeemed;
        vaultEscrowed = _isVaultEscrowed(vaultId);
        if (vaultRedeemed || !vaultEscrowed) return (vaultRedeemed, vaultEscrowed);

        console.log("Polling every 5 seconds for up to 120 seconds...");
        uint256 elapsed = 0;
        while (elapsed < 120) {
            vm.sleep(5000);
            elapsed += 5;
            (status,) = _getVaultStatusAndAmount(vaultId);
            vaultRedeemed = status == BTCVaultTypes.BTCVaultStatus.Redeemed;
            vaultEscrowed = _isVaultEscrowed(vaultId);
            if (vaultRedeemed || !vaultEscrowed) {
                console.log("Acquisition detected after", elapsed, "seconds");
                return (vaultRedeemed, vaultEscrowed);
            }
            console.log("Still waiting for acquisition...", elapsed, "/ 120");
        }
    }

    /// @dev Read vault ID from temporary file created by LiquidationE2ESetup
    /// @return The vault ID, or bytes32(0) if file doesn't exist
    function _readVaultIdFromFile() internal view returns (bytes32) {
        try vm.readFile(".e2e-vault-id") returns (string memory content) {
            return vm.parseBytes32(content);
        } catch {
            return bytes32(0);
        }
    }

    function _isVaultEscrowed(bytes32 vaultId) internal returns (bool) {
        bytes memory result =
            ffi_castCall(address(vaultSwap), "isVaultEscrowed(bytes32)", ArrayHelper.create(vm.toString(vaultId)));
        return abi.decode(result, (bool));
    }

    /// @dev Read via FFI. The public mapping getter `btcVaultsBasicInfo(bytes32)` flattens
    ///      `BTCVaultBasicInfo { depositor, depositorBtcPubKey, amount, vaultProvider, status,
    ///      applicationEntryPoint, createdAt }` into a 7-element ABI tuple in field order.
    function _getVaultStatusAndAmount(bytes32 vaultId)
        internal
        returns (BTCVaultTypes.BTCVaultStatus status, uint256 amount)
    {
        bytes memory result = ffi_castCall(
            address(btcVaultRegistry), "btcVaultsBasicInfo(bytes32)", ArrayHelper.create(vm.toString(vaultId))
        );
        (,, amount,, status,,) =
            abi.decode(result, (address, bytes32, uint256, address, BTCVaultTypes.BTCVaultStatus, address, uint256));
    }
}
