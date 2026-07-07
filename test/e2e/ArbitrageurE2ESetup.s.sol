// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {BaseE2ESetup} from "./abstract/BaseE2ESetup.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ArbitrageurE2ESetup
/// @notice E2E setup for the **arbitrageur bot** suite — a single arb bot running
///         **both engines** (liquidation + vault acquisition), fed by one unified
///         Ponder indexer in both modes. Replaces the previous two-bot setup:
///         the arb bot liquidates the position (creating an escrowed vault) and
///         then acquires it.
/// @dev Run ArbitrageurE2EVerify.s.sol after this.
contract ArbitrageurE2ESetup is BaseE2ESetup {
    /// @dev The arbitrageur's signer address to fund. Defaults to the baked-in local key's
    ///      address; override with `E2E_ARB_ADDRESS` when the bot signs via AWS KMS (the KMS
    ///      key derives a different address, and that is what must hold the funds).
    address internal arbAddr;

    function run() public {
        init(vm);
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        arbAddr = vm.envOr("E2E_ARB_ADDRESS", E2EConstants.ARBITRAGEUR);

        console.log("\n=== E2E Arbitrageur Setup (one bot, both engines) ===");
        console.log("Arbitrageur signer address:", arbAddr);

        // Fund the arbitrageur with ETH (gas), WBTC (LLP float + acquisitions),
        // and USDC (debt repayment for the liquidation leg it now runs itself).
        console.log("\n--- Fund Arbitrageur ---");
        vm.startBroadcast(adminPrivateKey);
        payable(arbAddr).transfer(10 ether);
        wbtc.mint(arbAddr, 10 * uint256(ONE_BTC));
        usdc.mint(arbAddr, 10_000 * ONE_USDC);
        vm.stopBroadcast();
        console.log("Arbitrageur funded with 10 ETH, 10 WBTC, 10,000 USDC");

        AaveAdapterLens lens = _deployLens();
        string memory startBlock = _getCurrentBlockNumber();

        // Write env (arb + liquidation config in one file → Phase A enables the
        // LiquidationEngine; the unified Ponder runs both modes) and start the
        // indexer + the single bot BEFORE the position becomes liquidatable.
        console.log("\n--- Write .env + start arbitrageur processes ---");
        _createArbitrageurEnvFile(address(lens), startBlock);
        _startProcess(".env.arbitrageur", "arbitrageur:indexer", "/tmp/arb-ponder.log");
        vm.sleep(10000); // Wait 10s for the unified Ponder to initialize
        _startProcess(".env.arbitrageur", "arbitrageur:run", "/tmp/arb-bot.log");
        _saveInitialBalances();

        (address borrower,) = _setupLiquidatablePosition(lens);

        console.log("\n=== Setup Complete - run ArbitrageurE2EVerify.s.sol ===");
        console.log("Borrower address:", borrower);
    }

    function _saveInitialBalances() internal {
        vm.writeFile(".e2e-initial-arb-wbtc", vm.toString(wbtc.balanceOf(arbAddr)));
        vm.writeFile(".e2e-initial-arb-usdc", vm.toString(usdc.balanceOf(arbAddr)));
    }

    /// @dev The signer lines for `.env.arbitrageur`. Default: the baked-in local private key
    ///      (unchanged). With `E2E_SIGNER_SOURCE=aws`, the bot signs via AWS KMS instead —
    ///      no key material in the env; `KMS_KEY_ID` + `AWS_REGION` come from the run env
    ///      (credentials resolve from the ambient AWS profile the bot process inherits).
    function _signerEnvLines() internal view returns (string memory) {
        bool useKms = keccak256(bytes(vm.envOr("E2E_SIGNER_SOURCE", string("local")))) == keccak256(bytes("aws"));
        if (!useKms) {
            return string.concat(
                "ARBITRAGEUR_PRIVATE_KEY=", vm.toString(bytes32(E2EConstants.ARBITRAGEUR_PRIVATE_KEY)), "\n"
            );
        }
        return string.concat(
            "SIGNER_SOURCE=aws\n",
            "KMS_KEY_ID=",
            vm.envString("KMS_KEY_ID"),
            "\n",
            "AWS_REGION=",
            vm.envString("AWS_REGION"),
            "\n",
            // Assert the KMS key derives the address we funded — the bot fails fast at
            // boot on a mismatch instead of dying later on gas/timeout errors.
            "SIGNER_ADDRESS=",
            vm.toString(arbAddr),
            "\n"
        );
    }

    /// @dev One `.env` for the whole bot: the unified Ponder mode-gates on the
    ///      addresses (SPOKE+ADAPTER ⇒ liquidation index, VAULT_SWAP ⇒ arbitrage
    ///      index), and the arb client enables its LiquidationEngine when
    ///      ADAPTER_ADDRESS + LENS_ADDRESS are present.
    function _createArbitrageurEnvFile(address lensAddress, string memory startBlock) internal {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "cat > .env.arbitrageur << 'EOF'\n",
            "# Unified Ponder Indexer (both modes)\n",
            "PONDER_RPC_URL=",
            E2EConstants.RPC_URL,
            "\n",
            "SPOKE_ADDRESS=",
            vm.toString(address(aaveSpoke)),
            "\n",
            "ADAPTER_ADDRESS=",
            vm.toString(address(aaveAdapter)),
            "\n",
            "VAULT_SWAP_ADDRESS=",
            vm.toString(address(vaultSwap)),
            "\n",
            "CHAIN_ID=",
            vm.toString(E2EConstants.CHAIN_ID),
            "\n",
            "START_BLOCK=",
            startBlock,
            "\n",
            "PONDER_POLLING_INTERVAL=1000\n",
            "DATABASE_URL=",
            E2EConstants.ARBITRAGEUR_DB_URL,
            "\n",
            "DATABASE_SCHEMA=public\n",
            "\n",
            "# Arbitrageur Client (both engines)\n",
            _signerEnvLines(),
            "PONDER_URL=",
            E2EConstants.ARBITRAGEUR_PONDER_URL,
            "\n",
            "CLIENT_RPC_URL=",
            E2EConstants.RPC_URL,
            "\n",
            "WBTC_ADDRESS=",
            vm.toString(address(wbtc)),
            "\n",
            "MAX_SLIPPAGE_BPS=100\n",
            "POLLING_INTERVAL_MS=1000\n",
            "VAULT_PROCESSING_DELAY_MS=1000\n",
            "METRICS_PORT=9091\n",
            "\n",
            "# Liquidation engine (enabled by ADAPTER_ADDRESS + LENS_ADDRESS)\n",
            "LENS_ADDRESS=",
            vm.toString(lensAddress),
            "\n",
            "LLP_ADDRESS=",
            vm.toString(address(vaultSwap)),
            "\n",
            "DEBT_TOKEN_ADDRESSES=",
            vm.toString(address(usdc)),
            "\n",
            "LIQUIDATION_POLLING_INTERVAL_MS=1000\n",
            "\n",
            "# Retry Configuration\n",
            "RETRY_MAX_ATTEMPTS=3\n",
            "RETRY_INITIAL_DELAY_MS=1000\n",
            "RETRY_MAX_DELAY_MS=30000\n",
            "TX_RECEIPT_TIMEOUT_MS=120000\n",
            "EOF"
        );
        vm.ffi(inputs);
    }
}
