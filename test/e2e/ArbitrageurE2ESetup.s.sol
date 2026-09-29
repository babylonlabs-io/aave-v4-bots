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

    function run() public virtual {
        init(vm);
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        arbAddr = vm.envOr("E2E_ARB_ADDRESS", E2EConstants.ARBITRAGEUR);

        console.log("\n=== E2E Arbitrageur Setup (one bot, both engines) ===");
        console.log("Arbitrageur signer address:", arbAddr);

        // Gas: set the arbitrageur's ETH balance immediately (not via broadcast).
        // arbAddr is APP_OPERATOR_0 (or the KMS-derived signer via E2E_ARB_ADDRESS) —
        // a registered vault keeper, so not a genesis-funded Anvil account. The bot is
        // spawned mid-run() below, before forge broadcasts any funding tx, so a broadcast
        // transfer would land too late and the bot's first approval would fail on gas;
        // anvil_setBalance is instant.
        _provisionGas(arbAddr, 10 ether);

        // WBTC (LLP float + acquisitions) and USDC (debt repayment for the
        // liquidation leg) are only needed once the bot acts on a position, well
        // after these broadcasts land, so a normal mint is fine.
        console.log("\n--- Fund Arbitrageur ---");
        vm.startBroadcast(adminPrivateKey);
        wbtc.mint(arbAddr, 10 * uint256(ONE_BTC));
        usdc.mint(arbAddr, 10_000 * ONE_USDC);
        vm.stopBroadcast();
        console.log("Arbitrageur funded with 10 ETH (gas), 10 WBTC, 10,000 USDC");

        // Hook for suites whose executor is not the signer above — the MANUAL `safe` suite deploys
        // and funds the Safe here, before the env file names it. Default: nothing to do.
        _setupExecutor(adminPrivateKey);

        AaveAdapterLens lens = _deployLens();
        string memory startBlock = _getCurrentBlockNumber();

        // Write env (arb + liquidation config in one file → Phase A enables the
        // LiquidationEngine; the unified Ponder runs both modes) and start the
        // indexer + the single bot BEFORE the position becomes liquidatable.
        console.log("\n--- Write .env + start arbitrageur processes ---");
        _createArbitrageurEnvFile(address(lens), startBlock);
        _startProcess(".env.arbitrageur", "arbitrageur:indexer", "/tmp/arb-ponder.log");
        vm.sleep(10000); // Wait 10s for the unified Ponder to initialize
        // The bot waits for the Lens (this script's last-broadcast deploy) before booting, so its
        // risk-gate code-hash check never races the forge broadcast phase. See `_startBotProcess`.
        _startBot(address(lens));
        _saveInitialBalances();

        _createPositions(lens);

        console.log("\n=== Setup Complete - run this suite's verify script ===");
    }

    /// @dev Launch the bot. It waits for the pinned Lens bytecode before booting, because the
    ///      code-hash guard boots HALTED if the contract is not there yet — and forge only flushes
    ///      its broadcasts once the script body returns, so the deploy lands late. That wait is
    ///      bounded (60s), which is ample for a one-position setup but not for suites whose script
    ///      body runs for minutes; those override this and start the bot afterwards instead.
    function _startBot(address lensAddress) internal virtual {
        _startBotProcess(".env.arbitrageur", "arbitrageur:run", "/tmp/arb-bot.log", lensAddress);
    }

    /// @dev The position(s) this suite drives the bot against. Default: the single borrower the AUTO
    ///      and MANUAL suites use, made liquidatable before we return. The stress suite overrides
    ///      this to build two cohorts and leave them **healthy** — there, the price drops that start
    ///      each wave are fired by the drive script, after the bot is already running.
    function _createPositions(AaveAdapterLens lens) internal virtual {
        (address borrower,) = _setupLiquidatablePosition(lens);
        console.log("Borrower address:", borrower);
    }

    function _saveInitialBalances() internal virtual {
        vm.writeFile(".e2e-initial-arb-wbtc", vm.toString(wbtc.balanceOf(arbAddr)));
        vm.writeFile(".e2e-initial-arb-usdc", vm.toString(usdc.balanceOf(arbAddr)));
    }

    /// @dev Stand up an executor distinct from the funded signer. Only the MANUAL `safe` suite
    ///      needs this (it deploys + funds the Safe that pays); every other suite executes as the
    ///      signer itself, so the default is a no-op.
    function _setupExecutor(uint256 adminPrivateKey) internal virtual {}

    /// @dev How this bot executes, as `.env.arbitrageur` lines. Default (AUTO): the baked-in local
    ///      private key. With `E2E_SIGNER_SOURCE=aws`, the bot signs via AWS KMS instead — no key
    ///      material in the env; `KMS_KEY_ID` + `AWS_REGION` come from the run env (credentials
    ///      resolve from the ambient AWS profile the bot process inherits). The MANUAL suites
    ///      override this to emit `EXECUTION_MODE=MANUAL` + the executor, and no key at all.
    function _executionEnvLines() internal view virtual returns (string memory) {
        bool useKms = keccak256(bytes(vm.envOr("E2E_SIGNER_SOURCE", string("local")))) == keccak256(bytes("aws"));
        if (!useKms) {
            return
                string.concat(
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
    function _createArbitrageurEnvFile(address lensAddress, string memory startBlock) internal virtual {
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
            vm.toString(block.chainid),
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
            _executionEnvLines(),
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
            "VAULT_PROCESSING_DELAY_MS=0\n", // batch acquisitions; throttle off
            "METRICS_PORT=",
            vm.toString(E2EConstants.ARBITRAGEUR_METRICS_PORT),
            "\n",
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
            "\n",
            "# Risk gate (ONE gate shared by BOTH engines this process runs)\n",
            _riskEnv(lensAddress),
            "EOF"
        );
        vm.ffi(inputs);
    }

    /// @notice Risk-gate env for the arbitrageur, which runs the arbitrage AND liquidation engines
    ///         off one signer and therefore one shared `RiskGate`.
    /// @dev Pins the **real deployed bytecode** of every contract the process calls:
    ///      `address.codehash` is `keccak256(runtime code)`, exactly what the bot's `readCodeHash`
    ///      computes from `eth_getCode`. Disagreement boots the bot HALTED, so it never acquires a
    ///      vault and the verify script times out — this suite is the only place the code-hash
    ///      guard runs against a real chain.
    ///
    ///      `RISK_MIN_PROFIT` and `RISK_MAX_DATA_STALENESS_MS` are deliberately unset: both are
    ///      covered by engine unit tests, and both would couple this suite to Anvil's block
    ///      cadence and to e2e-specific pricing.
    /// @dev Exposure cap (`RISK_MAX_IN_FLIGHT`) for the bot under test. Suites that liquidate more
    ///      positions than this at once must raise it, or the cap — not the behaviour under test —
    ///      becomes the binding constraint and the bot sits out most of the event.
    function _maxInFlight() internal view virtual returns (uint256) {
        return 5;
    }

    function _riskEnv(address lensAddress) internal view returns (string memory) {
        string memory hashes = string.concat(
            "RISK_EXPECTED_CODE_HASHES=",
            vm.toString(address(vaultSwap)),
            "=",
            vm.toString(address(vaultSwap).codehash),
            ",",
            vm.toString(address(aaveAdapter)),
            "=",
            vm.toString(address(aaveAdapter).codehash),
            ",",
            vm.toString(lensAddress),
            "=",
            vm.toString(lensAddress.codehash),
            "\n"
        );

        return string.concat(
            // Generous on purpose. These two exist here to prove the env parses and the gate is
            // wired into the engines, not to be exercised: a genuinely broken bot fails this suite
            // by never trading. Tight thresholds would only add CI flake.
            "RISK_MAX_CONSECUTIVE_FAILURES=10\n",
            "RISK_MAX_IN_FLIGHT=",
            vm.toString(_maxInFlight()),
            "\n",
            hashes,
            "RISK_CODE_CHECK_INTERVAL_MS=5000\n",
            "RISK_CONTROL_TOKEN_REF=",
            E2EConstants.CONTROL_TOKEN_REF,
            "\n",
            E2EConstants.CONTROL_TOKEN_REF,
            "=",
            E2EConstants.CONTROL_TOKEN,
            "\n",
            "RISK_CONTROL_PORT=",
            vm.toString(E2EConstants.ARBITRAGEUR_CONTROL_PORT),
            "\n",
            "RISK_CONTROL_HOST=127.0.0.1\n"
        );
    }
}
