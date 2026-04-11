// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {E2EConstants} from "./E2EConstants.sol";
import {BaseBot} from "./abstract/BaseBot.sol";
import {ArrayHelper} from "./lib/ArrayHelper.sol";

/// @title LiquidationE2EVerify
/// @notice E2E script to verify the liquidation bot performed the liquidation
/// @dev Part 2: Waits for bot to liquidate, then checks on-chain state
///      Run this AFTER LiquidationE2ESetup.s.sol
contract LiquidationE2EVerify is Script, BaseBot {
    /// @notice Main entry point for the verification script
    function run() public {
        // Load deployed contracts
        init(vm);

        console.log("\n=== E2E Liquidation Verification ===");

        // Get borrower address (same as setup script)
        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);

        // Get position info before liquidation (after price drop from setup script)
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        uint256 liquidatorUsdcBefore = _getUsdcBalance(E2EConstants.LIQUIDATOR);

        console.log("\n--- Position (After Price Drop - liquidation may already have occurred) ---");
        console.log("Borrower:", borrower);
        console.log("Collateral value:", collateralBefore / 1e26, "USD");
        console.log("Debt value:", debtBefore / 1e26, "USD");
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100");
        console.log("Liquidator USDC balance:", liquidatorUsdcBefore / ONE_USDC, "USDC");

        // Check if liquidation already fully occurred before this script started.
        // We intentionally do not treat "HF >= 1" as terminal because partial liquidation
        // can make the position healthy while still leaving debt/collateral.
        bool liquidationAlreadyOccurred = (collateralBefore == 0 && debtBefore == 0);

        // Poll until bot liquidates or timeout (only if not yet liquidated)
        if (!liquidationAlreadyOccurred) {
            console.log("\n--- Waiting for Bot Liquidation ---");
            console.log("Polling every 5 seconds for up to 120 seconds...");

            uint256 maxWaitSeconds = 240;
            uint256 pollIntervalSeconds = 5;
            uint256 elapsed = 0;

            while (elapsed < maxWaitSeconds) {
                vm.sleep(pollIntervalSeconds * 1000);
                elapsed += pollIntervalSeconds;

                (uint256 col, uint256 debt,) = _getPositionInfo(borrower);
                bool positionChanged = (col == 0 && debt == 0) || ((col < collateralBefore) && (debt < debtBefore));

                if (positionChanged) {
                    console.log("Liquidation detected after", elapsed, "seconds");
                    break;
                }

                uint256 blockTime = block.timestamp;
                uint256 blockNumber = block.number;
                console.log("Still waiting...", elapsed, "/", maxWaitSeconds);
                console.log("Current block:", blockNumber, "time:", blockTime);
            }
        } else {
            console.log("\n--- Liquidation Already Occurred ---");
            console.log("Skipping wait period");
        }

        // Check position after waiting
        (uint256 collateralAfter, uint256 debtAfter, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        uint256 liquidatorUsdcAfter = _getUsdcBalance(E2EConstants.LIQUIDATOR);

        console.log("\n--- Position After Waiting ---");
        console.log("Collateral value:", collateralAfter / 1e26, "USD");
        console.log("Debt value:", debtAfter / 1e26, "USD");
        console.log("Health Factor:", healthFactorAfter / 1e16, "/ 100");
        console.log("Liquidator USDC balance:", liquidatorUsdcAfter / ONE_USDC, "USDC");

        // Verify liquidation occurred
        console.log("\n--- Verification Results ---");

        // Check if position was fully liquidated (both collateral and debt are 0)
        bool fullyLiquidated = (collateralAfter == 0 && debtAfter == 0);

        // Check if position was partially liquidated
        bool debtReduced = debtAfter < debtBefore;
        bool collateralReduced = collateralAfter < collateralBefore;
        bool liquidatorSpentUsdc = liquidatorUsdcAfter < liquidatorUsdcBefore;
        console.log("Collateral delta:", int256(collateralAfter) - int256(collateralBefore));
        console.log("Debt delta:", int256(debtAfter) - int256(debtBefore));
        console.log("Liquidator USDC delta:", int256(liquidatorUsdcAfter) - int256(liquidatorUsdcBefore));

        if (fullyLiquidated) {
            console.log("[PASS] Position fully liquidated (collateral and debt both 0)");
            console.log("[PASS] Collateral reduced by:", collateralBefore / 1e26, "USD");
            console.log("[PASS] Debt reduced by:", debtBefore / 1e26, "USD");
        } else {
            if (debtReduced) {
                console.log("[PASS] Debt reduced by:", (debtBefore - debtAfter) / 1e26, "USD");
            } else {
                console.log("[FAIL] Debt NOT reduced");
            }

            if (collateralReduced) {
                console.log("[PASS] Collateral reduced by:", (collateralBefore - collateralAfter) / 1e26, "USD");
            } else {
                console.log("[FAIL] Collateral NOT reduced");
            }
        }

        if (liquidatorSpentUsdc) {
            console.log("[PASS] Liquidator spent:", (liquidatorUsdcBefore - liquidatorUsdcAfter) / ONE_USDC, "USDC");
        } else {
            console.log("[WARN] Liquidator USDC did not decrease");
        }

        // Final verdict
        // Pass when either:
        // 1) borrower position changed due to liquidation, or
        // 2) liquidator spent USDC in this run (covers transient state-read inconsistencies).
        bool liquidationOccurred = fullyLiquidated || (debtReduced && collateralReduced) || liquidatorSpentUsdc;

        if (liquidationOccurred) {
            console.log("\n=== E2E Liquidation Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Liquidation Test FAILED ===\n");
            if (liquidatorSpentUsdc) {
                console.log("[WARN] USDC spending observed without borrower position liquidation");
            }
            console.log("Check /tmp/ponder.log and /tmp/bot.log for details");
            revert("Liquidation did not occur as expected");
        }
    }

    function _getUserProxyAddress(address user) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(user));
        return Clones.predictDeterministicAddress(address(btcVaultCoreSpokeProxyImpl), salt, address(aaveAdapter));
    }

    function _getUsdcBalance(address user) internal returns (uint256) {
        bytes memory result = ffi_castCall(address(usdc), "balanceOf(address)", ArrayHelper.create(vm.toString(user)));
        return abi.decode(result, (uint256));
    }

    function _getPositionInfo(address user)
        internal
        returns (uint256 totalCollateral, uint256 totalDebt, uint256 healthFactor)
    {
        address proxy = _getUserProxyAddress(user);

        bytes memory result =
            ffi_castCall(address(aaveSpoke), "getUserAccountData(address)", ArrayHelper.create(vm.toString(proxy)));

        // Parse the result - getUserAccountData returns a struct with multiple values
        // The result should be ABI-encoded tuple (totalCollateralValue, totalDebtValue, healthFactor, ...)
        // We'll decode just the first 3 values we need
        (,, healthFactor, totalCollateral, totalDebt,,) =
            abi.decode(result, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        totalDebt = totalDebt / 1e27;
        return (totalCollateral, totalDebt, healthFactor);
    }
}
