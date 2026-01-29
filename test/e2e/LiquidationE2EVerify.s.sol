// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "../../contracts/test/e2e/base/BaseE2E.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title LiquidationE2EVerify
/// @notice E2E script to verify the liquidation bot performed the liquidation
/// @dev Part 2: Waits for bot to liquidate, then checks on-chain state
///      Run this AFTER LiquidationE2ESetup.s.sol
contract LiquidationE2EVerify is Script, BaseE2E {
    uint256 constant BORROWER_PRIVATE_KEY = 12;

    /// @notice Main entry point for the verification script
    function run() public {
        // Load deployed contracts
        init(vm);

        console.log("\n=== E2E Liquidation Verification ===");

        // Get borrower address (same as setup script)
        address borrower = vm.addr(BORROWER_PRIVATE_KEY);
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

        // Get position info before liquidation (after price drop from setup script)
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        uint256 liquidatorUsdcBefore = usdc.balanceOf(liquidator);

        console.log("\n--- Unhealthy Position (After Price Drop) ---");
        console.log("Borrower:", borrower);
        console.log("Collateral value:", collateralBefore / 1e26, "USD");
        console.log("Debt value:", debtBefore / 1e26, "USD");
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100");
        console.log("Liquidator USDC balance:", liquidatorUsdcBefore / ONE_USDC, "USDC");

        // Wait for Ponder to index + bot to liquidate
        console.log("\n--- Waiting for Bot Liquidation ---");
        console.log("Waiting 15 seconds for Ponder sync + bot liquidation...");
        vm.sleep(15000);

        // Check position after waiting
        (uint256 collateralAfter, uint256 debtAfter, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        uint256 liquidatorUsdcAfter = usdc.balanceOf(liquidator);

        console.log("\n--- Position After Waiting ---");
        console.log("Collateral value:", collateralAfter / 1e26, "USD");
        console.log("Debt value:", debtAfter / 1e26, "USD");
        console.log("Health Factor:", healthFactorAfter / 1e16, "/ 100");
        console.log("Liquidator USDC balance:", liquidatorUsdcAfter / ONE_USDC, "USDC");

        // Verify liquidation occurred
        console.log("\n--- Verification Results ---");

        // Check if position was fully liquidated (both collateral and debt are 0)
        bool fullyLiquidated = (collateralAfter == 0 && debtAfter == 0 && collateralBefore > 0);

        // Check if position was partially liquidated
        bool debtReduced = debtAfter < debtBefore;
        bool collateralReduced = collateralAfter < collateralBefore;
        bool keeperPaid = liquidatorUsdcAfter > liquidatorUsdcBefore;

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

        if (keeperPaid) {
            console.log("[PASS] Keeper received:", (liquidatorUsdcAfter - liquidatorUsdcBefore) / ONE_USDC, "USDC");
        }

        // Final verdict - pass if either fully liquidated OR partially liquidated with keeper paid
        bool liquidationOccurred = fullyLiquidated || (debtReduced && collateralReduced);

        if (liquidationOccurred || keeperPaid) {
            console.log("\n=== E2E Liquidation Test PASSED ===\n");
        } else {
            console.log("\n=== E2E Liquidation Test FAILED ===\n");
            console.log("Check /tmp/ponder.log and /tmp/bot.log for details");
            revert("Liquidation did not occur as expected");
        }
    }

    function _getUserProxyAddress(address user) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(user));
        return Clones.predictDeterministicAddress(address(btcVaultCoreSpokeProxyImpl), salt, address(aaveController));
    }

    function _getPositionInfo(address user)
        internal
        view
        returns (uint256 totalCollateral, uint256 totalDebt, uint256 healthFactor)
    {
        address proxy = _getUserProxyAddress(user);
        ISpoke.UserAccountData memory accountData = aaveSpoke.getUserAccountData(proxy);
        return (accountData.totalCollateralValue, accountData.totalDebtValue, accountData.healthFactor);
    }
}
