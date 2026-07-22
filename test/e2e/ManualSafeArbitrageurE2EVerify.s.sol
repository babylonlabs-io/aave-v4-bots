// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ManualSafeArbitrageurE2EVerify
/// @notice Asserts the MANUAL Safe arbitrageur flow really executed **both** engines: the operator
///         drove each proposal through `operator-cli`, the Safe's `execTransaction` ran them, the
///         borrower's position was cleared (liquidation leg) and the escrowed vault left escrow
///         (acquisition leg) — with the **Safe** paying throughout.
/// @dev Balances are the Safe's, read from the address `ManualSafeArbitrageurE2ESetup` wrote to
///      `.e2e-safe-address`. The acquisition went through `swapWbtcForVaultOnBehalf`, so the vault
///      is redeemed to ARBITRAGEUR's BTC key while the WBTC leaves the SAFE — asserting the Safe's
///      WBTC fell is what proves the payer/beneficiary split actually worked.
contract ManualSafeArbitrageurE2EVerify is Script, BaseBot {
    function run() public {
        init(vm);

        console.log("\n=== E2E MANUAL Safe Arbitrageur Verification (both engines) ===");

        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);
        address safe = vm.parseAddress(vm.readFile(".e2e-safe-address"));
        bytes32 vaultId = _readVaultIdFromFile();
        require(vaultId != bytes32(0), "Missing vault ID from setup");

        console.log("Safe (executor/payer):", safe);
        console.log("Vault keeper (beneficiary):", E2EConstants.ARBITRAGEUR);

        uint256 initialWbtc = _readInitialBalance(".e2e-initial-safe-wbtc");

        // ── Leg 1: liquidation ────────────────────────────────────────────
        console.log("\n--- Leg 1: liquidation (position cleared) ---");
        // Longer budgets than the AUTO suite: every action here waits on a full operator
        // round-trip (claim -> external sign -> confirm), not just the bot's next poll.
        require(_waitForLiquidation(borrower, 240), "Position was not liquidated via the Safe");
        console.log("[PASS] Borrower position cleared (col == 0 && debt == 0)");

        // ── Leg 2: acquisition, paid by the Safe on behalf of the keeper ──
        console.log("\n--- Leg 2: vault acquisition (on behalf of the keeper) ---");
        console.log("Vault ID:", vm.toString(vaultId));
        require(_waitForAcquisition(vaultId, 240), "Vault was not acquired via the Safe");
        console.log("[PASS] Vault acquired (redeemed / left escrow)");

        // The Safe is the payer on BOTH legs. It receives WBTC from the LLP payout when it
        // liquidates and spends WBTC when it acquires; the acquisition costs the vault's full debt
        // plus fee, which is far larger than the liquidation payout, so the net must be negative.
        // A Safe whose WBTC did NOT fall would mean something else paid — exactly the failure the
        // payer/beneficiary split could hide.
        uint256 nowWbtc = _getWbtcBalance(safe);
        console.log("\n--- Safe WBTC (sats) ---");
        console.log("Initial:", initialWbtc);
        console.log("Now:    ", nowWbtc);
        require(nowWbtc < initialWbtc, "Safe did not pay for the acquisition");
        console.log("[PASS] Safe paid for the acquisition");

        // The other half of the split: the keeper received the vault (to its BTC key, off-chain)
        // without spending anything on-chain. "Vault left escrow" alone would also be satisfied if
        // the keeper had quietly paid for it itself — which is exactly the regression that would
        // mean the on-behalf routing silently fell back to the direct call. Asserting the keeper's
        // WBTC is untouched, alongside the Safe's having fallen, pins the payer and the beneficiary
        // to different accounts.
        uint256 keeperInitialWbtc = _readInitialBalance(".e2e-initial-arb-wbtc");
        uint256 keeperNowWbtc = _getWbtcBalance(E2EConstants.ARBITRAGEUR);
        console.log("\n--- Keeper WBTC (sats) ---");
        console.log("Initial:", keeperInitialWbtc);
        console.log("Now:    ", keeperNowWbtc);
        require(keeperNowWbtc == keeperInitialWbtc, "Keeper paid: the acquisition was not on-behalf");
        console.log("[PASS] Keeper spent nothing (the Safe paid on its behalf)");

        // Both engines traded, so the ONE shared risk gate let them: the code-hash guard accepted
        // the real deployed bytecode (a mismatch boots the process HALTED, stopping both). Exercise
        // the control plane last, so a kill-switch failure can never mask a trading failure.
        console.log("\n--- Verifying kill switch on the running bot ---");
        _checkKillSwitch(
            E2EConstants.ARBITRAGEUR_CONTROL_PORT, E2EConstants.ARBITRAGEUR_METRICS_PORT, E2EConstants.CONTROL_TOKEN
        );
        console.log("[PASS] Kill switch: auth, method + traversal guards, halt/resume, loopback-only");

        console.log("\n=== E2E MANUAL Safe Arbitrageur Test PASSED (both engines) ===\n");
    }
}
