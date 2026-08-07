// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";

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
    function run() public virtual {
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
        require(_waitForLiquidation(borrower, 240), "Position was not liquidated by the arb bot's LiquidationEngine");
        console.log("[PASS] Borrower position cleared (col == 0 && debt == 0)");

        // ── Leg 2: vault acquisition (the bot's ArbitrageEngine) ──────────
        console.log("\n--- Leg 2: vault acquisition ---");
        console.log("Vault ID:", vm.toString(vaultId));
        bool acquired = _waitForAcquisition(vaultId, 120);

        uint256 arbWbtcNow = _getWbtcBalance(vm.envOr("E2E_ARB_ADDRESS", E2EConstants.ARBITRAGEUR));
        console.log("Arbitrageur WBTC now (sats):  ", arbWbtcNow);
        console.log("Arbitrageur WBTC initial (sats):", arbInitialWbtc);

        require(acquired, "Vault was not acquired by the arb bot's ArbitrageEngine");
        console.log("[PASS] Vault acquired (redeemed / left escrow)");

        // Both engines traded, which proves the ONE shared gate let them: the code-hash guard
        // accepted the real deployed bytecode of VaultSwap, the adapter and the lens (a mismatch
        // boots the process HALTED, stopping *both* engines). Now exercise the control plane on
        // the live process, last so a kill-switch failure can never mask a trading failure.
        console.log("\n--- Verifying kill switch on the running bot ---");
        _checkKillSwitch(
            E2EConstants.ARBITRAGEUR_CONTROL_PORT, E2EConstants.ARBITRAGEUR_METRICS_PORT, E2EConstants.CONTROL_TOKEN
        );
        console.log("[PASS] Kill switch: auth, method + traversal guards, halt/resume, loopback-only");

        console.log("\n=== E2E Arbitrageur Test PASSED (both engines) ===\n");
    }
}
