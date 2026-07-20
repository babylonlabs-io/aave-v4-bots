// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {LiquidationE2ESetup} from "./LiquidationE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";
import {E2ESafe} from "./helpers/E2ESafe.sol";

/// @title ManualSafeLiquidationE2ESetup
/// @notice E2E setup for the **MANUAL (Safe)** liquidator suite. A 1-of-1 Safe (owner = LIQUIDATOR)
///         is the executor: it holds the USDC + WBTC and is `msg.sender` of the liquidation. The bot
///         boots keyless in `safe` custody and only *proposes*; `operator-cli` signs each SafeTx with
///         the owner key and submits `execTransaction`, driven by `operator-broadcast.sh`.
/// @dev Verify with ManualSafeLiquidationE2EVerify (it reads the Safe address + the Safe's balances).
contract ManualSafeLiquidationE2ESetup is LiquidationE2ESetup {
    E2ESafe internal safe;

    function run() public override {
        init(vm);
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console.log("\n=== E2E MANUAL Safe Liquidation Setup ===");

        // Deploy a 1-of-1 Safe owned by LIQUIDATOR, then fund the SAFE (not the EOA) — the Safe is the
        // executor whose balances/allowances the engine reads and who repays debt + receives WBTC.
        vm.startBroadcast(adminPrivateKey);
        address[] memory owners = new address[](1);
        owners[0] = E2EConstants.LIQUIDATOR;
        safe = new E2ESafe(owners, 1);
        usdc.mint(address(safe), 10_000 * ONE_USDC);
        wbtc.mint(address(safe), 1 * uint256(ONE_BTC));
        vm.stopBroadcast();
        vm.writeFile(".e2e-safe-address", vm.toString(address(safe)));
        console.log("Safe (executor):", address(safe), "funded with 10,000 USDC + 1 WBTC");

        AaveAdapterLens lens = _deployLens();
        string memory startBlock = _getCurrentBlockNumber();

        console.log("\n--- Write .env + start keyless (safe) liquidator processes ---");
        _createEnvFile(address(lens), startBlock);
        _startProcess(".env.liquidator", "liquidator:indexer", "/tmp/liq-ponder.log");
        vm.sleep(10000);
        _startBotProcess(".env.liquidator", "liquidator:run", "/tmp/liq-bot.log", address(lens));
        _saveInitialBalances();

        (address borrower,) = _setupLiquidatablePosition(lens);

        console.log("\n=== Setup Complete - drive operator-cli, then ManualSafeLiquidationE2EVerify ===");
        console.log("Borrower address:", borrower);
    }

    /// Save the SAFE's balances (the executor) — the Safe verify compares against these.
    function _saveInitialBalances() internal override {
        vm.writeFile(".e2e-initial-safe-wbtc", vm.toString(wbtc.balanceOf(address(safe))));
        vm.writeFile(".e2e-initial-safe-usdc", vm.toString(usdc.balanceOf(address(safe))));
    }

    function _createEnvFile(address lensAddress, string memory startBlock) internal override {
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
            "# Liquidation Client - MANUAL Safe (keyless): executor is the Safe, NO private key\n",
            "EXECUTION_MODE=MANUAL\n",
            "MANUAL_EXECUTOR_KIND=safe\n",
            "MANUAL_EXECUTOR_ADDRESS=",
            vm.toString(address(safe)),
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
            "METRICS_PORT=",
            vm.toString(E2EConstants.LIQUIDATOR_METRICS_PORT),
            "\n",
            "\n",
            "# Risk gate\n",
            _riskEnv(lensAddress),
            "EOF"
        );
        vm.ffi(inputs);
    }
}
