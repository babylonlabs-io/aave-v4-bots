// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "test-e2e-base/BaseE2E.sol";
import {IBTCVaultsManager} from "vault-contracts/interfaces/IBTCVaultsManager.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ArbitrageurE2EVerify
/// @notice E2E script to verify the arbitrageur bot acquired vaults and paid WBTC
/// @dev Part 3: Waits for arbitrageur bot to acquire escrowed vaults from liquidator
///      Run this AFTER LiquidationE2EVerify.s.sol
contract ArbitrageurE2EVerify is Script, BaseE2E {
    /// @notice Main entry point for the verification script
    function run() public {
        // Load deployed contracts
        init(vm);

        console.log("\n=== E2E Arbitrageur Verification ===");

        // Read vault ID from file created by LiquidationE2ESetup
        bytes32 vaultId = _readVaultIdFromFile();

        // Get initial balances and ownership
        uint256 arbWbtcBefore = wbtc.balanceOf(E2EConstants.ARBITRAGEUR);
        uint256 liquidatorWbtcBefore = wbtc.balanceOf(E2EConstants.LIQUIDATOR);
        address vaultOwnerBefore = bytes32(0) == vaultId ? address(0) : aaveController.getVaultOwner(vaultId);

        console.log("\n--- Before Arbitrageur Acquisition ---");
        console.log("Arbitrageur:", E2EConstants.ARBITRAGEUR);
        console.log("Arbitrageur WBTC balance:", arbWbtcBefore / 1e8, "WBTC");
        console.log("Liquidator:", E2EConstants.LIQUIDATOR);
        console.log("Liquidator WBTC balance:", liquidatorWbtcBefore / 1e8, "WBTC");

        if (bytes32(0) != vaultId) {
            console.log("\nVault ID:", vm.toString(vaultId));
            console.log("Vault owner before:", vaultOwnerBefore);

            IBTCVaultsManager.BTCVault memory vault = vaultManager.getBTCVault(vaultId);
            console.log("Vault BTC amount:", vault.amount / 1e8, "BTC");

            // Check if vault is escrowed in VaultSwap
            bool isEscrowed = vaultSwap.isVaultEscrowed(vaultId);
            console.log("Is vault escrowed in VaultSwap:", isEscrowed);

            if (!isEscrowed) {
                console.log("[INFO] Vault is not escrowed - checking if already acquired by arbitrageur");
            }
        } else {
            console.log("\n[WARN] No vault ID found - will rely on balance checks only");
        }

        // Wait for arbitrageur bot to process
        console.log("\n--- Waiting for Arbitrageur Bot ---");
        console.log("Waiting 10 seconds for arbitrageur to acquire vaults...");
        vm.sleep(10000);

        // Check balances and ownership after waiting
        uint256 arbWbtcAfter = wbtc.balanceOf(E2EConstants.ARBITRAGEUR);
        uint256 liquidatorWbtcAfter = wbtc.balanceOf(E2EConstants.LIQUIDATOR);
        address vaultOwnerAfter = bytes32(0) == vaultId ? address(0) : aaveController.getVaultOwner(vaultId);

        console.log("\n--- After Arbitrageur Acquisition ---");
        console.log("Arbitrageur WBTC balance:", arbWbtcAfter / 1e8, "WBTC");
        console.log("Liquidator WBTC balance:", liquidatorWbtcAfter / 1e8, "WBTC");

        if (bytes32(0) != vaultId) {
            console.log("Vault owner after:", vaultOwnerAfter);

            bool isEscrowedAfter = vaultSwap.isVaultEscrowed(vaultId);
            console.log("Is vault still escrowed:", isEscrowedAfter);
        }

        // Verify arbitrageur acquired vaults
        console.log("\n--- Verification Results ---");

        bool vaultAcquired = false;
        bool wbtcPaid = arbWbtcAfter < arbWbtcBefore;
        bool liquidatorReceivedWbtc = liquidatorWbtcAfter > liquidatorWbtcBefore;

        // Check vault ownership
        if (bytes32(0) != vaultId) {
            vaultAcquired = vaultOwnerAfter == E2EConstants.ARBITRAGEUR;

            if (vaultAcquired) {
                console.log("[PASS] Arbitrageur now owns the vault");
            } else if (vaultOwnerBefore == E2EConstants.ARBITRAGEUR) {
                console.log("[PASS] Arbitrageur already owned the vault before this check");
                vaultAcquired = true; // Count as success
            } else {
                console.log("[INFO] Vault not owned by arbitrageur. Owner:", vaultOwnerAfter);
            }
        }

        // Check WBTC payment
        if (wbtcPaid) {
            uint256 wbtcSpent = arbWbtcBefore - arbWbtcAfter;
            console.log("[PASS] Arbitrageur paid:", wbtcSpent / 1e8, "WBTC");
        } else {
            console.log("[INFO] Arbitrageur WBTC balance unchanged");
        }

        // Check liquidator received payment
        if (liquidatorReceivedWbtc) {
            uint256 wbtcReceived = liquidatorWbtcAfter - liquidatorWbtcBefore;
            console.log("[PASS] Liquidator received:", wbtcReceived / 1e8, "WBTC from VaultSwap");
        } else {
            console.log("[INFO] Liquidator WBTC balance unchanged");
        }

        // Final verdict
        // Success if:
        // 1. Vault was acquired by arbitrageur (either now or before), OR
        // 2. WBTC was paid and liquidator received payment (for cases without vault ID tracking)
        bool success = vaultAcquired || (wbtcPaid && liquidatorReceivedWbtc);

        if (success) {
            console.log("\n=== E2E Arbitrageur Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Arbitrageur Test FAILED ===\n");
            console.log("Check /tmp/arb-ponder.log and /tmp/arb-bot.log for details");
            console.log("\nExpected:");
            console.log("- Arbitrageur to own the vault, OR");
            console.log("- Arbitrageur to pay WBTC AND liquidator to receive WBTC");
            revert("Arbitrage did not occur as expected");
        }
    }

    /// @dev Read vault ID from temporary file created by LiquidationE2ESetup
    /// @return The vault ID, or bytes32(0) if file doesn't exist
    function _readVaultIdFromFile() internal returns (bytes32) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
            "[ -f .e2e-vault-id ] && cat .e2e-vault-id | tr -d '\\n' || echo '0x0000000000000000000000000000000000000000000000000000000000000000'";

        return bytes32(vm.ffi(inputs));
    }
}
