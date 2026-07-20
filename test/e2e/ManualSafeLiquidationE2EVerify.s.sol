// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ManualSafeLiquidationE2EVerify
/// @notice Asserts the MANUAL Safe liquidator flow really executed: the operator-cli signed the
///         SafeTxs, the Safe's `execTransaction` ran them, and the position was cleared with the
///         **Safe** (the executor) spending USDC + receiving WBTC. Balances are the Safe's — read
///         from the address `ManualSafeLiquidationE2ESetup` wrote to `.e2e-safe-address`.
contract ManualSafeLiquidationE2EVerify is Script, BaseBot {
    function run() public {
        init(vm);

        console.log("\n=== E2E MANUAL Safe Liquidation Verification ===");

        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);
        address safe = vm.parseAddress(vm.readFile(".e2e-safe-address"));
        console.log("Safe (executor):", safe);

        uint256 initialWbtc = _readInitialBalance(".e2e-initial-safe-wbtc");
        uint256 initialUsdc = _readInitialBalance(".e2e-initial-safe-usdc");

        (uint256 col, uint256 debt,) = _getPositionInfo(borrower);
        if (col > 0 || debt > 0) {
            console.log("\n--- Waiting for operator-signed Safe liquidation ---");
            uint256 maxWaitSeconds = 240;
            uint256 elapsed = 0;
            while (elapsed < maxWaitSeconds) {
                vm.sleep(5000);
                elapsed += 5;
                (col, debt,) = _getPositionInfo(borrower);
                if (col == 0 && debt == 0) {
                    console.log("Liquidation detected after", elapsed, "seconds");
                    break;
                }
                console.log("Still waiting...", elapsed, "/", maxWaitSeconds);
            }
        } else {
            console.log("\n--- Liquidation already occurred ---");
        }

        uint256 nowWbtc = _getWbtcBalance(safe);
        uint256 nowUsdc = _getUsdcBalance(safe);

        console.log("\n--- Safe USDC ---");
        console.log("Initial:", initialUsdc / ONE_USDC, "USDC");
        console.log("Now:    ", nowUsdc / ONE_USDC, "USDC");
        console.log("\n--- Safe WBTC (sats) ---");
        console.log("Initial:", initialWbtc);
        console.log("Now:    ", nowWbtc);

        bool positionLiquidated = (col == 0 && debt == 0);
        bool safeSpentUsdc = nowUsdc < initialUsdc;
        bool safeReceivedWbtc = nowWbtc > initialWbtc;

        console.log("\n--- Verification Results ---");
        console.log(positionLiquidated ? "[PASS] position liquidated" : "[FAIL] position NOT liquidated");
        console.log(safeSpentUsdc ? "[PASS] Safe spent USDC repaying debt" : "[FAIL] Safe USDC unchanged");
        console.log(safeReceivedWbtc ? "[PASS] Safe received WBTC (LLP payout)" : "[FAIL] Safe WBTC unchanged");

        if (positionLiquidated && safeSpentUsdc && safeReceivedWbtc) {
            console.log("\n--- Verifying kill switch on the running bot ---");
            _checkKillSwitch(
                E2EConstants.LIQUIDATOR_CONTROL_PORT,
                E2EConstants.LIQUIDATOR_METRICS_PORT,
                E2EConstants.CONTROL_TOKEN
            );
            console.log("[PASS] Kill switch");
            console.log("\n=== E2E MANUAL Safe Liquidation Test PASSED ===\n");
        } else {
            console.log("\n=== E2E MANUAL Safe Liquidation Test FAILED ===\n");
            console.log("Check /tmp/liq-ponder.log and /tmp/liq-bot.log");
            revert("Safe liquidation did not occur as expected");
        }
    }
}
