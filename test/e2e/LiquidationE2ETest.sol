// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {BaseE2ETest} from "../../contracts/test/e2e/base/BaseE2ETest.sol";
import {BtcHelpers} from "../../contracts/test/utils/BtcHelpers.sol";
import {console} from "forge-std/console.sol";

contract LiquidationE2ETest is BaseE2ETest {
    // Bot process management
    string public botProcessId;
    string public ponderProcessId;

    function setUp() public override {
        super.setUp(); // Load deployed contracts from DeploymentState

        // Create .env file with deployed contract addresses
        _createEnvFile();

        // Start Ponder indexer (uses existing `pnpm indexer` script)
        ponderProcessId = _startPonder();

        // Start liquidation bot (uses existing `pnpm liquidate` script)
        botProcessId = _startBot();
    }

    function test_E2E_Smoke_BotAndPonderStart() public view {
        // Smoke test to verify bot and ponder started successfully
        console.log("Bot PID:", botProcessId);
        console.log("Ponder PID:", ponderProcessId);

        assertTrue(bytes(botProcessId).length > 0, "Bot should have started");
        assertTrue(bytes(ponderProcessId).length > 0, "Ponder should have started");
    }

    // ============ Helper Functions ============

    function _createEnvFile() internal {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "cat > .env << 'EOF'\n",
            "# Ponder config\n",
            "PONDER_RPC_URL_1=http://localhost:8545\n",
            "SPOKE_ADDRESS=",
            vm.toString(address(aaveSpoke)),
            "\n",
            "START_BLOCK=0\n",
            "DATABASE_URL=postgresql://ponder:ponder@localhost:5432/ponder\n",
            "DATABASE_SCHEMA=public\n",
            "PONDER_POLLING_INTERVAL=1000\n",
            "\n",
            "# Liquidation bot config\n",
            "LIQUIDATOR_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d\n",
            "PONDER_URL=http://localhost:42069\n",
            "RPC_URL=http://localhost:8545\n",
            "CONTROLLER_ADDRESS=",
            vm.toString(address(aaveController)),
            "\n",
            "VAULT_SWAP_ADDRESS=",
            vm.toString(address(vaultSwap)),
            "\n",
            "DEBT_TOKEN_ADDRESSES=",
            vm.toString(address(usdc)),
            "\n",
            "WBTC_ADDRESS=",
            vm.toString(address(wbtc)),
            "\n",
            "POLLING_INTERVAL_MS=1000\n",
            "EOF"
        );
        vm.ffi(inputs);
    }

    function _startPonder() internal returns (string memory) {
        // Use existing pnpm script from package.json
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "pnpm indexer > /tmp/ponder.log 2>&1 & echo $!";
        bytes memory result = vm.ffi(inputs);

        // Convert PID from FFI bytes to string
        // FFI returns decimal numbers as hex bytes, use BtcHelpers.convertToUint256
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Ponder started with PID:", pid);
        return pid;
    }

    function _startBot() internal returns (string memory) {
        // Use existing pnpm script from package.json
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "pnpm liquidate > /tmp/bot.log 2>&1 & echo $!";
        bytes memory result = vm.ffi(inputs);

        // Convert PID from FFI bytes to string using BtcHelpers utility
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Bot started with PID:", pid);
        return pid;
    }

    function _getPositionInfo(address user) internal view returns (uint256 supplied, uint256 borrowed) {
        // Query Aave spoke for user position
        // TODO: Implement actual position query
        return (0, 0);
    }

    function tearDown() public {
        // Kill bot and ponder processes
        _killProcess(botProcessId);
        _killProcess(ponderProcessId);
    }

    function _killProcess(string memory pid) internal {
        if (bytes(pid).length > 0) {
            string[] memory inputs = new string[](3);
            inputs[0] = "kill";
            inputs[1] = "-9";
            inputs[2] = pid;
            vm.ffi(inputs);
        }
    }
}
