// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {BaseE2ESetup} from "./abstract/BaseE2ESetup.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title LiquidationE2ESetup
/// @notice E2E setup for the **liquidator bot** suite — a standalone liquidator
///         bot + its Ponder indexer (liquidation mode). Sets up one liquidatable
///         position for the bot to clear.
/// @dev Run LiquidationE2EVerify.s.sol after this. The arbitrageur suite (one arb
///      bot running both engines) lives in ArbitrageurE2ESetup.s.sol.
contract LiquidationE2ESetup is BaseE2ESetup {
    function run() public {
        init(vm);
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console.log("\n=== E2E Liquidation Setup (liquidator bot) ===");

        // Fund liquidator with USDC (debt repayment) and WBTC (LLP working float)
        console.log("\n--- Fund Liquidator ---");
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(E2EConstants.LIQUIDATOR, 10_000 * ONE_USDC);
        wbtc.mint(E2EConstants.LIQUIDATOR, 1 * uint256(ONE_BTC));
        vm.stopBroadcast();
        console.log("Liquidator funded with 10,000 USDC and 1 WBTC");

        AaveAdapterLens lens = _deployLens();
        string memory startBlock = _getCurrentBlockNumber();

        // Write env, start the indexer + bot BEFORE creating the position so the
        // bot is already polling when the position becomes liquidatable.
        console.log("\n--- Write .env + start liquidator processes ---");
        _createEnvFile(address(lens), startBlock);
        _startProcess(".env.liquidator", "liquidator:indexer", "/tmp/liq-ponder.log");
        vm.sleep(10000); // Wait 10s for Ponder to initialize
        _startProcess(".env.liquidator", "liquidator:run", "/tmp/liq-bot.log");
        _saveInitialBalances();

        (address borrower,) = _setupLiquidatablePosition(lens);

        console.log("\n=== Setup Complete - run LiquidationE2EVerify.s.sol ===");
        console.log("Borrower address:", borrower);
    }

    function _saveInitialBalances() internal {
        vm.writeFile(".e2e-initial-liq-wbtc", vm.toString(wbtc.balanceOf(E2EConstants.LIQUIDATOR)));
        vm.writeFile(".e2e-initial-liq-usdc", vm.toString(usdc.balanceOf(E2EConstants.LIQUIDATOR)));
    }

    function _createEnvFile(address lensAddress, string memory startBlock) internal {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "cat > .env.liquidator << 'EOF'\n",
            "# Ponder Indexer\n",
            "PONDER_RPC_URL=",
            E2EConstants.RPC_URL,
            "\n",
            "SPOKE_ADDRESS=",
            vm.toString(address(aaveSpoke)),
            "\n",
            "ADAPTER_ADDRESS=",
            vm.toString(address(aaveAdapter)),
            "\n",
            "CHAIN_ID=",
            vm.toString(E2EConstants.CHAIN_ID),
            "\n",
            "START_BLOCK=",
            startBlock,
            "\n",
            "PONDER_POLLING_INTERVAL=1000\n",
            "DATABASE_URL=",
            E2EConstants.LIQUIDATOR_DB_URL,
            "\n",
            "DATABASE_SCHEMA=public\n",
            "\n",
            "# Liquidation Client\n",
            "LIQUIDATOR_PRIVATE_KEY=",
            vm.toString(bytes32(E2EConstants.LIQUIDATOR_PRIVATE_KEY)),
            "\n",
            "PONDER_URL=",
            E2EConstants.LIQUIDATOR_PONDER_URL,
            "\n",
            "CLIENT_RPC_URL=",
            E2EConstants.RPC_URL,
            "\n",
            "LENS_ADDRESS=",
            vm.toString(lensAddress),
            "\n",
            "DEBT_TOKEN_ADDRESSES=",
            vm.toString(address(usdc)),
            "\n",
            "WBTC_ADDRESS=",
            vm.toString(address(wbtc)),
            "\n",
            "LLP_ADDRESS=",
            vm.toString(address(vaultSwap)),
            "\n",
            "POLLING_INTERVAL_MS=1000\n",
            "METRICS_PORT=9090\n",
            "EOF"
        );
        vm.ffi(inputs);
    }
}
