// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "test-e2e-base/BaseE2E.sol";
import {IBTCVaultsManager} from "vault-contracts/interfaces/IBTCVaultsManager.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ArbitrageurE2EVerify
/// @notice E2E script to verify the arbitrageur bot acquired vaults from VaultSwap
/// @dev Part 3: Checks that the arbitrageur bot atomically acquired + redeemed the vault.
///      With the new atomic flow, swapWbtcForVault redeems internally, so the vault status
///      becomes Redeemed and the vault is no longer escrowed. We verify by comparing WBTC
///      balances against the known initial funding amounts from the setup script.
///      Run this AFTER LiquidationE2EVerify.s.sol
contract ArbitrageurE2EVerify is Script, BaseE2E {
    /// @notice Main entry point for the verification script
    function run() public {
        // Load deployed contracts
        init(vm);

        console.log("\n=== E2E Arbitrageur Verification ===");

        // Read vault ID from file created by LiquidationE2ESetup
        bytes32 vaultId = _readVaultIdFromFile();
        require(vaultId != bytes32(0), "Missing vault ID from setup");
        uint256 arbInitialWbtc = _readInitialWbtcBalance("ARB_INITIAL_WBTC");
        uint256 liqInitialWbtc = _readInitialWbtcBalance("LIQ_INITIAL_WBTC");

        // Get current WBTC balances
        uint256 arbWbtcNow = wbtc.balanceOf(E2EConstants.ARBITRAGEUR);
        uint256 liquidatorWbtcNow = wbtc.balanceOf(E2EConstants.LIQUIDATOR);

        console.log("Arbitrageur:", E2EConstants.ARBITRAGEUR);
        console.log("Arbitrageur WBTC balance (sats):", arbWbtcNow);
        console.log("Arbitrageur initial WBTC (sats):", arbInitialWbtc);
        console.log("Liquidator:", E2EConstants.LIQUIDATOR);
        console.log("Liquidator WBTC balance (sats):", liquidatorWbtcNow);
        console.log("Liquidator initial WBTC (sats):", liqInitialWbtc);

        // Check vault status
        bool vaultRedeemed = false;
        bool vaultEscrowed = false;

        console.log("\nVault ID:", vm.toString(vaultId));

        IBTCVaultsManager.BTCVault memory vault = vaultManager.getBTCVault(vaultId);
        console.log("Vault status:", uint8(vault.status));
        console.log("Vault BTC amount:", vault.amount, "sats");

        vaultRedeemed = vault.status == IBTCVaultsManager.BTCVaultStatus.Redeemed;
        vaultEscrowed = vaultSwap.isVaultEscrowed(vaultId);

        console.log("Is vault redeemed:", vaultRedeemed);
        console.log("Is vault escrowed in VaultSwap:", vaultEscrowed);

        // If vault is still escrowed, poll until the arbitrageur bot processes it
        if (vaultEscrowed) {
            console.log("\n--- Waiting for Arbitrageur Bot ---");
            console.log("Polling every 5 seconds for up to 120 seconds...");

            uint256 maxWaitSeconds = 120;
            uint256 pollIntervalSeconds = 5;
            uint256 elapsed = 0;

            while (elapsed < maxWaitSeconds) {
                vm.sleep(pollIntervalSeconds * 1000);
                elapsed += pollIntervalSeconds;

                vault = vaultManager.getBTCVault(vaultId);
                vaultRedeemed = vault.status == IBTCVaultsManager.BTCVaultStatus.Redeemed;
                vaultEscrowed = vaultSwap.isVaultEscrowed(vaultId);

                if (vaultRedeemed || !vaultEscrowed) {
                    console.log("Arbitrage detected after", elapsed, "seconds");
                    break;
                }
                console.log("Still waiting...", elapsed, "/", maxWaitSeconds);
            }

            // Re-read final balances
            arbWbtcNow = wbtc.balanceOf(E2EConstants.ARBITRAGEUR);
            liquidatorWbtcNow = wbtc.balanceOf(E2EConstants.LIQUIDATOR);

            console.log("\n--- After Waiting ---");
            console.log("Arbitrageur WBTC balance:", arbWbtcNow, "sats");
            console.log("Liquidator WBTC balance:", liquidatorWbtcNow, "sats");
            console.log("Is vault redeemed:", vaultRedeemed);
            console.log("Is vault still escrowed:", vaultEscrowed);
        }

        // Verification: compare balances against initial funding
        console.log("\n--- Verification Results ---");

        // Arbitrageur spent WBTC to acquire vault (balance decreased from initial)
        bool arbSpentWbtc = arbWbtcNow < arbInitialWbtc;
        // Liquidator received WBTC from liquidation via VaultSwap (balance increased from initial)
        bool liqReceivedWbtc = liquidatorWbtcNow > liqInitialWbtc;

        if (vaultRedeemed) {
            console.log("[PASS] Vault status is Redeemed (atomic acquisition + redemption completed)");
        }

        if (arbSpentWbtc) {
            uint256 wbtcSpent = arbInitialWbtc - arbWbtcNow;
            console.log("[PASS] Arbitrageur spent:", wbtcSpent, "sats WBTC to acquire vault");
        } else {
            console.log("[INFO] Arbitrageur WBTC balance unchanged from initial funding");
        }

        if (liqReceivedWbtc) {
            uint256 wbtcReceived = liquidatorWbtcNow - liqInitialWbtc;
            console.log("[PASS] Liquidator received:", wbtcReceived, "sats WBTC from VaultSwap");
        } else {
            console.log("[INFO] Liquidator WBTC balance unchanged from initial funding");
        }

        // Final verdict:
        // With atomic redemption flow, success is indicated by:
        // 1. Vault is redeemed (status = Redeemed), OR
        // 2. Vault left escrow AND both balance-side effects are present
        bool success = vaultRedeemed || (!vaultEscrowed && arbSpentWbtc && liqReceivedWbtc);

        if (success) {
            console.log("\n=== E2E Arbitrageur Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Arbitrageur Test FAILED ===\n");
            console.log("Check /tmp/arb-ponder.log and /tmp/arb-bot.log for details");
            console.log("\nExpected (atomic redemption flow):");
            console.log("- Vault status to be Redeemed, OR");
            console.log("- Arbitrageur WBTC to decrease AND liquidator WBTC to increase from initial funding");
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

    function _readInitialWbtcBalance(string memory envName) internal returns (uint256) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "[ -f .e2e-initial-balances ] && { set -a; . ./.e2e-initial-balances; set +a; echo -n $",
            envName,
            "; } || echo -n 0"
        );
        bytes memory raw = vm.ffi(inputs);
        string memory value = string(raw);
        uint256 parsed = vm.parseUint(value);
        require(parsed > 0, "Missing initial WBTC balances from setup");
        return parsed;
    }
}
