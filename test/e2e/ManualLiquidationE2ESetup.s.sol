// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LiquidationE2ESetup} from "./LiquidationE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ManualLiquidationE2ESetup
/// @notice E2E setup for the **MANUAL (EOA)** liquidator suite. Identical to the AUTO liquidator
///         setup except the bot boots **keyless**: `EXECUTION_MODE=MANUAL`, `MANUAL_EXECUTOR_KIND=eoa`,
///         and NO `LIQUIDATOR_PRIVATE_KEY`. The bot only *proposes* the approval + liquidation into its
///         `StateStore`; an operator (with the key the bot does not have) broadcasts them via
///         `operator-cli`, driven by `test/e2e/scripts/operator-broadcast.sh` between setup and verify.
/// @dev Reuses the whole AUTO `run()` (fund → deploy Lens → boot → liquidatable position); only the
///      env file differs, so `_createEnvFile` is overridden. Verify with LiquidationE2EVerify.
contract ManualLiquidationE2ESetup is LiquidationE2ESetup {
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
            "# Liquidation Client - MANUAL (keyless): NO LIQUIDATOR_PRIVATE_KEY\n",
            "EXECUTION_MODE=MANUAL\n",
            "MANUAL_EXECUTOR_KIND=eoa\n",
            "MANUAL_EXECUTOR_ADDRESS=",
            vm.toString(E2EConstants.LIQUIDATOR),
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
