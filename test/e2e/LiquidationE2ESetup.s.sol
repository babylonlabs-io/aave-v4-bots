// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "test-e2e-base/BaseE2E.sol";
import {BtcHelpers} from "test-utils/BtcHelpers.sol";
import {PopHelpers} from "test-utils/PopHelpers.sol";
import {TestKeys} from "test-utils/TestKeys.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {BTCProofOfPossession} from "vault-contracts/lib/pop/BTCProofOfPossession.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AaveIntegrationLens} from "vault-contracts/applications/aave/AaveIntegrationLens.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title LiquidationE2ESetup
/// @notice E2E script to setup a liquidatable position for the liquidation bot
/// @dev Part 1: Creates unhealthy position, starts bot/ponder, persists state
///      Run LiquidationE2EVerify.s.sol after this to verify liquidation occurred
contract LiquidationE2ESetup is Script, BaseE2E {
    bytes32 internal constant _E2E_LAMPORT_PK_HASH = keccak256("test_lamport_key");

    /// @notice Main entry point for the setup script
    function run() public {
        // Call parent setUp to load all deployed contracts and environment
        init(vm);

        // Load admin private key for broadcasting transactions
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");

        console.log("\n=== E2E Liquidation Setup ===");

        // Fund liquidator with USDC and WBTC
        console.log("\n--- Step 1: Fund Liquidator ---");
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(E2EConstants.LIQUIDATOR, 10_000 * ONE_USDC);
        wbtc.mint(E2EConstants.LIQUIDATOR, 1 * uint256(ONE_BTC));
        vm.stopBroadcast();
        console.log("Liquidator funded with 10,000 USDC and 1 WBTC");

        // Fund arbitrageur with ETH and WBTC
        console.log("\n--- Step 2: Fund Arbitrageur ---");
        vm.startBroadcast(adminPrivateKey);
        payable(E2EConstants.ARBITRAGEUR).transfer(10 ether);
        wbtc.mint(E2EConstants.ARBITRAGEUR, 10 * uint256(ONE_BTC));
        vm.stopBroadcast();
        console.log("Arbitrageur funded with 10 ETH and 10 WBTC");
        _saveInitialWbtcBalances();

        // Deploy AaveIntegrationLens for liquidation estimation
        console.log("\n--- Step 3: Deploy Lens ---");
        vm.startBroadcast(adminPrivateKey);
        AaveIntegrationLens lens =
            new AaveIntegrationLens(address(btcVaultRegistry), address(aaveAdapter), address(aaveSpoke), vaultBtcId);
        vm.stopBroadcast();
        console.log("Lens deployed at:", address(lens));

        // Get current block number so Ponder can skip deployment blocks
        string memory startBlock = _getCurrentBlockNumber();

        // Create .env files with deployed contract addresses for bots and Ponder
        console.log("\n--- Step 4: Create .env Files ---");
        _createEnvFile(address(lens), startBlock);
        _createArbitrageurEnvFile(startBlock);

        // Start Ponder indexers
        console.log("\n--- Step 5: Start Liquidator Ponder ---");
        string memory ponderProcessId = _startLiquidatorPonder();
        vm.sleep(10000); // Wait 10s for Ponder to initialize
        console.log("Liquidator Ponder is ready!");

        console.log("\n--- Step 6: Start Arbitrageur Ponder ---");
        string memory arbPonderProcessId = _startArbitrageurPonder();
        vm.sleep(10000); // Wait 10s for Arbitrageur Ponder to initialize
        console.log("Arbitrageur Ponder is ready!");

        // Start bots
        console.log("\n--- Step 7: Start Liquidator Bot ---");
        string memory botProcessId = _startLiquidatorBot();
        console.log("Liquidator Bot is ready!");

        console.log("\n--- Step 8: Start Arbitrageur Bot ---");
        string memory arbBotProcessId = _startArbitrageurBot();
        console.log("Arbitrageur Bot is ready!");

        // Create borrower and fund with ETH
        console.log("\n--- Step 9: Create Borrower ---");
        address borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);
        vm.startBroadcast(adminPrivateKey);
        payable(borrower).transfer(10 ether);
        vm.stopBroadcast();
        console.log("Borrower address:", borrower);

        // Pegin BTC
        console.log("\n--- Step 10: Pegin BTC ---");
        uint64 peginAmount = uint64(ONE_BTC / 10); // 0.1 BTC (must be >= minimumPegInAmount of 5,460,000 sats)
        bytes32 depositorBtcPubKey = TestKeys.TEST_DEPOSITOR_BTC_PUBKEY;
        bytes32 vaultId = _doPegInScript(E2EConstants.BORROWER_PRIVATE_KEY, depositorBtcPubKey, peginAmount);
        console.log("Pegin completed, vaultId:", vm.toString(vaultId));

        // Save vault ID for arbitrageur verification script
        _saveVaultId(vaultId);

        // Note: Collateral is auto-added during pegin activation (auto-collateralization)

        // Setup liquidity (USDC for borrowing and WBTC for VaultSwap)
        console.log("\n--- Step 11: Setup Liquidity ---");
        _setUpLiquidityScript();

        // Borrow USDC
        console.log("\n--- Step 12: Borrow USDC ---");
        uint256 borrowAmount = 3000 * ONE_USDC;
        _borrowFromPositionScript(E2EConstants.BORROWER_PRIVATE_KEY, borrowAmount, borrower);
        console.log("Borrowed:", borrowAmount / ONE_USDC, "USDC");

        // Check position is healthy
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        console.log("\n--- Position Before Price Drop ---");
        console.log("Collateral value:", collateralBefore / 1e26, "USD");
        console.log("Debt value:", debtBefore / 1e26, "USD");
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100");
        require(healthFactorBefore > 1e18, "Position should be healthy initially");

        // Simulate price drop
        console.log("\n--- Step 13: Price Drop ---");
        vm.startBroadcast(adminPrivateKey);
        btcPriceFeed.simulatePriceDrop(40); // 40% drop
        vm.stopBroadcast();
        console.log("BTC price dropped by 40%");

        // Verify position is now unhealthy
        (,, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        console.log("Health Factor after drop:", healthFactorAfter / 1e16, "/ 100");
        require(healthFactorAfter < 1e18, "Position should be unhealthy after price drop");

        console.log("\n=== Setup Complete ===");
        console.log("Run LiquidationE2EVerify.s.sol to verify liquidation and arbitrage");
        console.log("Borrower address:", borrower);
        console.log("Liquidator Ponder PID:", ponderProcessId);
        console.log("Liquidator Bot PID:", botProcessId);
        console.log("Arbitrageur Ponder PID:", arbPonderProcessId);
        console.log("Arbitrageur Bot PID:", arbBotProcessId);
    }

    // ============ Helper Functions ============

    function _doPegInScript(uint256 depositorPrivateKey, bytes32 depositorBtcPubKey, uint256 amountSats)
        internal
        returns (bytes32 vaultId)
    {
        address depositor = vm.addr(depositorPrivateKey);
        bytes32 vaultProviderBtcKey = btcVaultRegistry.getVaultProviderBTCKey(vp);
        bytes memory btcPopSignature =
            PopHelpers.getBip322P2wpkh(vm, depositorBtcPubKey, BTCProofOfPossession.ACTION_PEGIN, address(btcVaultRegistry));
        (bytes memory unsignedPeginTx, string memory prevoutTxid, uint32 prevoutVout, uint64 utxoAmount) =
            _generateUnsignedPeginTx(depositorBtcPubKey, vaultProviderBtcKey, uint64(amountSats), address(aaveAdapter));

        // Get required pegin fee and fund depositor
        uint256 pegInFee = btcVaultRegistry.getPegInFee(vp);
        vm.deal(depositor, depositor.balance + pegInFee);

        vm.startBroadcast(depositorPrivateKey);
        vaultId = btcVaultRegistry.submitPeginRequest{value: pegInFee}(
            depositor, depositorBtcPubKey, btcPopSignature, unsignedPeginTx, vp, _E2E_LAMPORT_PK_HASH
        );
        vm.stopBroadcast();

        _collectPeginACKs(vaultId);
        string memory txid =
            _signAndBroadcastPeginTx(unsignedPeginTx, depositorBtcPubKey, prevoutTxid, prevoutVout, utxoAmount);

        vm.startBroadcast(vpPrivKey);
        _submitInclusionProofAndActivateVault(vaultId, txid);
        vm.stopBroadcast();

        return vaultId;
    }

    function _borrowFromPositionScript(uint256 borrowerPrivateKey, uint256 amountUsdc, address receiver) internal {
        uint256 balanceBefore = usdc.balanceOf(receiver);

        vm.startBroadcast(borrowerPrivateKey);
        aaveAdapter.borrowFromCorePosition(usdcId, amountUsdc, receiver);
        vm.stopBroadcast();

        uint256 balanceAfter = usdc.balanceOf(receiver);
        require(balanceAfter - balanceBefore == amountUsdc, "received amount mismatched");
    }

    function _setUpLiquidityScript() internal {
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");

        vm.startBroadcast(adminPrivateKey);

        // Add USDC liquidity to Aave Spoke for borrowing
        uint256 usdcAmountToSupply = ONE_USDC * 1_000_000;
        usdc.mint(admin, usdcAmountToSupply);
        usdc.approve(address(aaveSpoke), usdcAmountToSupply);
        aaveSpoke.supply(usdcId, usdcAmountToSupply, admin);

        // Add WBTC liquidity to Hub for VaultSwap
        uint256 wbtcLiquidity = 1000e8; // 1000 WBTC
        wbtc.mint(address(hub), wbtcLiquidity);
        hub.add(wbtcId, wbtcLiquidity);

        vm.stopBroadcast();
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
            "POLLING_INTERVAL_MS=1000\n",
            "METRICS_PORT=9090\n",
            "EOF"
        );
        vm.ffi(inputs);
    }

    function _createArbitrageurEnvFile(string memory startBlock) internal {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "cat > .env.arbitrageur << 'EOF'\n",
            "# Ponder Indexer\n",
            "PONDER_RPC_URL=",
            E2EConstants.RPC_URL,
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
            "# Arbitrageur Client\n",
            "ARBITRAGEUR_PRIVATE_KEY=",
            vm.toString(bytes32(E2EConstants.ARBITRAGEUR_PRIVATE_KEY)),
            "\n",
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
            "# Retry Configuration\n",
            "RETRY_MAX_ATTEMPTS=3\n",
            "RETRY_INITIAL_DELAY_MS=1000\n",
            "RETRY_MAX_DELAY_MS=30000\n",
            "TX_RECEIPT_TIMEOUT_MS=120000\n",
            "EOF"
        );
        vm.ffi(inputs);
    }

    function _saveVaultId(bytes32 vaultId) internal {
        vm.writeFile(".e2e-vault-id", vm.toString(vaultId));
    }

    function _saveInitialWbtcBalances() internal {
        uint256 arbInitialWbtc = wbtc.balanceOf(E2EConstants.ARBITRAGEUR);
        uint256 liqInitialWbtc = wbtc.balanceOf(E2EConstants.LIQUIDATOR);
        vm.writeFile(".e2e-initial-arb-wbtc", vm.toString(arbInitialWbtc));
        vm.writeFile(".e2e-initial-liq-wbtc", vm.toString(liqInitialWbtc));
    }

    function _startLiquidatorPonder() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
            "{ set -a; [ -f .env.liquidator ] && . .env.liquidator; set +a; pnpm liquidator:indexer > /tmp/liq-ponder.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Liquidator ponder started with PID:", pid);
        return pid;
    }

    function _startLiquidatorBot() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
            "{ set -a; [ -f .env.liquidator ] && . .env.liquidator; set +a; pnpm liquidator:run > /tmp/liq-bot.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Liquidator bot started with PID:", pid);
        return pid;
    }

    function _startArbitrageurPonder() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
            "{ set -a; [ -f .env.arbitrageur ] && . .env.arbitrageur; set +a; pnpm arbitrageur:indexer > /tmp/arb-ponder.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Arbitrageur ponder started with PID:", pid);
        return pid;
    }

    function _startArbitrageurBot() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
            "{ set -a; [ -f .env.arbitrageur ] && . .env.arbitrageur; set +a; pnpm arbitrageur:run > /tmp/arb-bot.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Arbitrageur bot started with PID:", pid);
        return pid;
    }

    function _getUserProxyAddress(address user) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(user));
        return Clones.predictDeterministicAddress(address(btcVaultCoreSpokeProxyImpl), salt, address(aaveAdapter));
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

    function _getCurrentBlockNumber() internal returns (string memory) {
        // Write block number to file, then read with vm.readLine to avoid
        // FFI hex-decoding issues (all-digit output gets hex-decoded by Foundry)
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "cast block-number --rpc-url http://localhost:8545 > .e2e-block-number";
        vm.ffi(inputs);
        string memory blockNum = vm.readLine(".e2e-block-number");
        console.log("Current block number for START_BLOCK:", blockNum);
        return blockNum;
    }
}
