// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {E2EConstants} from "./E2EConstants.sol";
import {ArrayHelper} from "./lib/ArrayHelper.sol";

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
        console.log(
            "Spent:  ",
            initialUsdc > nowUsdc ? (initialUsdc - nowUsdc) / ONE_USDC : 0,
            "USDC"
        );

        console.log("\n--- Liquidator WBTC ---");
        console.log("Initial (sats):", initialWbtc);
        console.log("Now (sats):    ", nowWbtc);
        console.log("Gained (sats): ", nowWbtc > initialWbtc ? nowWbtc - initialWbtc : 0);

        // ── Pass / fail ───────────────────────────────────────────────────
        bool positionLiquidated = (col == 0 && debt == 0);
        bool liquidatorSpentUsdc = nowUsdc < initialUsdc;
        bool liquidatorReceivedWbtc = nowWbtc > initialWbtc;

        console.log("\n--- Verification Results ---");

        if (positionLiquidated) {
            console.log("[PASS] Borrower position fully liquidated on Spoke");
        } else {
            console.log("[FAIL] Borrower position NOT liquidated (collateral or debt > 0)");
        }
        if (liquidatorSpentUsdc) {
            console.log("[PASS] Liquidator spent USDC repaying debt");
        } else {
            console.log("[FAIL] Liquidator USDC balance unchanged from initial");
        }
        if (liquidatorReceivedWbtc) {
            console.log("[PASS] Liquidator received WBTC from LLP (sell-discount payout)");
        } else {
            console.log("[FAIL] Liquidator WBTC balance unchanged from initial");
        }

        if (positionLiquidated && liquidatorSpentUsdc && liquidatorReceivedWbtc) {
            console.log("\n=== E2E Liquidation Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Liquidation Test FAILED ===\n");
            console.log("Check /tmp/liq-ponder.log and /tmp/liq-bot.log for details");
            revert("Liquidation did not occur as expected");
        }
    }

    /// @dev Canonical proxy lookup (matches LiquidationE2ESetup). The
    ///      previous `Clones.predictDeterministicAddress` formula did not
    ///      match what the new adapter actually deploys, which produced
    ///      false-positive PASS readings (col=0/debt=0 from the wrong
    ///      account).
    function _getUserProxyAddress(address user) internal view returns (address) {
        return aaveAdapter.getPosition(user).proxyContract;
    }

    function _getUsdcBalance(address user) internal returns (uint256) {
        bytes memory result =
            ffi_castCall(address(usdc), "balanceOf(address)", ArrayHelper.create(vm.toString(user)));
        return abi.decode(result, (uint256));
    }

    function _getWbtcBalance(address user) internal returns (uint256) {
        bytes memory result =
            ffi_castCall(address(wbtc), "balanceOf(address)", ArrayHelper.create(vm.toString(user)));
        return abi.decode(result, (uint256));
    }

    /// @dev Read live position info via FFI so the polling loop sees
    ///      changes the bot makes outside this script's local EVM.
    ///      ISpoke.UserAccountData is 7 uint256s in this order:
    ///      (riskPremium, avgCollateralFactor, healthFactor,
    ///      totalCollateralValue, totalDebtValueRay, activeCollateralCount,
    ///      borrowCount).
    function _getPositionInfo(address user)
        internal
        returns (uint256 totalCollateral, uint256 totalDebt, uint256 healthFactor)
    {
        address proxy = _getUserProxyAddress(user);
        bytes memory result =
            ffi_castCall(address(aaveSpoke), "getUserAccountData(address)", ArrayHelper.create(vm.toString(proxy)));
        (,, healthFactor, totalCollateral, totalDebt,,) =
            abi.decode(result, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    function _readInitialBalance(string memory filename) internal view returns (uint256) {
        string memory content = vm.readFile(filename);
        uint256 parsed = vm.parseUint(content);
        require(parsed > 0, "Missing initial balance from setup");
        return parsed;
    }
}
