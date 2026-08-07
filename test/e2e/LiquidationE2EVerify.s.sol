// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title LiquidationE2EVerify
/// @notice Asserts the liquidation bot really executed the LLP-mode flow.
/// @dev Compares NOW (live, via FFI cast call) against INITIAL (snapshots
///      saved by LiquidationE2ESetup before the bot was started). Without
///      the initial snapshots this script can't tell that liquidation
///      happened — the bot is faster than this script's startup, so any
///      "before" reading taken here would already be post-liquidation.
///      The polling loop is kept for slow-CI cases.
///
///      Pass criteria (all three required):
///        - position fully liquidated on Spoke (col == 0 && debt == 0)
///        - liquidator's WBTC balance increased (LLP path payout)
///        - liquidator's USDC balance decreased (debt repayment)
contract LiquidationE2EVerify is Script, BaseBot {
    function run() public {
        init(vm);

        console.log("\n=== E2E Liquidation Verification ===");

        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);

        uint256 initialWbtc = _readInitialBalance(".e2e-initial-liq-wbtc");
        uint256 initialUsdc = _readInitialBalance(".e2e-initial-liq-usdc");

        // Wait for the bot to liquidate the position (or confirm it already did).
        (uint256 col, uint256 debt, uint256 hf) = _getPositionInfo(borrower);
        if (col > 0 || debt > 0) {
            console.log("\n--- Waiting for Bot Liquidation ---");
            console.log("Polling every 5 seconds for up to 240 seconds...");

            uint256 maxWaitSeconds = 240;
            uint256 pollIntervalSeconds = 5;
            uint256 elapsed = 0;
            while (elapsed < maxWaitSeconds) {
                vm.sleep(pollIntervalSeconds * 1000);
                elapsed += pollIntervalSeconds;

                (col, debt, hf) = _getPositionInfo(borrower);
                if (col == 0 && debt == 0) {
                    console.log("Liquidation detected after", elapsed, "seconds");
                    break;
                }
                console.log("Still waiting...", elapsed, "/", maxWaitSeconds);
            }
        } else {
            console.log("\n--- Liquidation Already Occurred ---");
            console.log("(Bot is faster than verify startup; reading post-liquidation state)");
        }

        // Snapshot live values once.
        uint256 nowWbtc = _getWbtcBalance(E2EConstants.LIQUIDATOR);
        uint256 nowUsdc = _getUsdcBalance(E2EConstants.LIQUIDATOR);

        // ── Display state with explicit INITIAL → NOW deltas ──────────────
        console.log("\n--- Borrower Position (live) ---");
        console.log("Borrower:        ", borrower);
        console.log("Collateral (USD):", col / 1e26);
        console.log("Debt (USD):      ", debt / 1e26);
        console.log("Health Factor:   ", hf / 1e16, "/ 100");

        console.log("\n--- Liquidator USDC ---");
        console.log("Initial:", initialUsdc / ONE_USDC, "USDC");
        console.log("Now:    ", nowUsdc / ONE_USDC, "USDC");
        console.log("Spent:  ", initialUsdc > nowUsdc ? (initialUsdc - nowUsdc) / ONE_USDC : 0, "USDC");

        console.log("\n--- Liquidator WBTC ---");
        console.log("Initial (sats):", initialWbtc);
        console.log("Now (sats):    ", nowWbtc);
        console.log("Gained (sats): ", nowWbtc > initialWbtc ? nowWbtc - initialWbtc : 0);

        // The LLP fairness payment is the ONLY thing that exercises the WBTC flash-loan leg, and it
        // lands here: the adapter pulls it from the liquidator (the router) and forwards it to the
        // borrower. The borrower holds no WBTC otherwise — they pegged in BTC and borrowed USDC — so
        // any balance at all is the payment, and in flash mode the router held none of its own.
        uint256 borrowerWbtc = _getWbtcBalance(borrower);
        console.log("\n--- Borrower WBTC (LLP fairness payment) ---");
        console.log("Received (sats):", borrowerWbtc);

        // ── Pass / fail ───────────────────────────────────────────────────
        bool positionLiquidated = (col == 0 && debt == 0);
        // The signature of flash funding, and the reason it is asserted rather than merely logged:
        // the router borrows the USDC and repays itself from the seized collateral, so the bot's own
        // USDC must be untouched. An inventory-funded liquidation spends it — so this is what
        // catches the bot silently falling back to the other mode, which a "position was
        // liquidated" check alone cannot.
        bool liquidatorUsdcUntouched = nowUsdc == initialUsdc;
        bool liquidatorReceivedWbtc = nowWbtc > initialWbtc;
        bool fairnessPaymentFlashFunded = borrowerWbtc > 0;

        console.log("\n--- Verification Results ---");

        if (positionLiquidated) {
            console.log("[PASS] Borrower position fully liquidated on Spoke");
        } else {
            console.log("[FAIL] Borrower position NOT liquidated (collateral or debt > 0)");
        }
        if (liquidatorUsdcUntouched) {
            console.log("[PASS] Liquidator spent no USDC (repayment was flash-funded)");
        } else {
            console.log("[FAIL] Liquidator USDC fell - the liquidation was funded from inventory");
        }
        if (liquidatorReceivedWbtc) {
            console.log("[PASS] Liquidator received WBTC (profit swept from the router)");
        } else {
            console.log("[FAIL] Liquidator WBTC balance unchanged from initial");
        }
        if (fairnessPaymentFlashFunded) {
            console.log("[PASS] Fairness payment reached the borrower (WBTC flash-loan leg ran)");
        } else {
            console.log("[FAIL] Borrower received no WBTC - the WBTC flash-loan leg never ran");
        }

        if (positionLiquidated && liquidatorUsdcUntouched && liquidatorReceivedWbtc && fairnessPaymentFlashFunded) {
            // The bot traded, which already proves the code-hash guard accepted the real deployed
            // bytecode (a mismatch would have booted it HALTED). Now exercise the control plane on
            // the live process, last so a kill-switch failure can never mask a trading failure.
            console.log("\n--- Verifying kill switch on the running bot ---");
            _checkKillSwitch(
                E2EConstants.LIQUIDATOR_CONTROL_PORT, E2EConstants.LIQUIDATOR_METRICS_PORT, E2EConstants.CONTROL_TOKEN
            );
            console.log("[PASS] Kill switch: auth, method + traversal guards, halt/resume, loopback-only");

            console.log("\n=== E2E Liquidation Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Liquidation Test FAILED ===\n");
            console.log("Check /tmp/liq-ponder.log and /tmp/liq-bot.log for details");
            revert("Liquidation did not occur as expected");
        }
    }
}
