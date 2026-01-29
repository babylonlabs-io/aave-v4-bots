// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DeploymentState} from "../../contracts/script/utils/DeploymentState.sol";
import {MockUSDC} from "vault-contracts/mocks/MockUSDC.sol";
import {MockWBTC} from "vault-contracts/mocks/MockWBTC.sol";

/// @title FundLiquidator
/// @notice Simple script to fund the liquidator with USDC and WBTC
/// @dev This script runs BEFORE LiquidationE2E to validate that minting persists on the actual Anvil chain
contract FundLiquidator is Script {
    uint256 public constant ONE_BTC = 1e8;
    uint256 public constant ONE_USDC = 1e6;

    function run() public {
        // Load admin private key
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");

        console.log("\n=== Funding Liquidator ===");
        console.log("Admin address:", admin);

        // Load deployed token contracts
        MockUSDC usdc = MockUSDC(DeploymentState.readAddress(vm, "MockUSDC"));
        MockWBTC wbtc = MockWBTC(DeploymentState.readAddress(vm, "MockWBTC"));

        console.log("USDC address:", address(usdc));
        console.log("WBTC address:", address(wbtc));

        // Liquidator address (matches LIQUIDATOR_PRIVATE_KEY in .env)
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        console.log("Liquidator address:", liquidator);

        // Mint tokens to liquidator
        console.log("\nMinting tokens...");
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(liquidator, 1000 * ONE_USDC);
        wbtc.mint(liquidator, 1 * uint256(ONE_BTC));
        vm.stopBroadcast();

        console.log("USDC minted: 1000");
        console.log("WBTC minted: 1");

        // Verify balances
        uint256 usdcBalance = usdc.balanceOf(liquidator);
        uint256 wbtcBalance = wbtc.balanceOf(liquidator);
        console.log("\nVerifying balances...");
        console.log("USDC balance:", usdcBalance / ONE_USDC);
        console.log("WBTC balance:", wbtcBalance / ONE_BTC);

        require(usdcBalance == 1000 * ONE_USDC, "USDC balance mismatch");
        require(wbtcBalance == 1 * uint256(ONE_BTC), "WBTC balance mismatch");

        console.log("\n=== Funding Complete ===\n");
    }
}
