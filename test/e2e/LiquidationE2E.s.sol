// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ActionE2EPegIn} from "../../contracts/test/e2e/action/ActionE2EPegIn.sol";
import {ActionE2EApplication} from "../../contracts/test/e2e/action/ActionE2EApplication.sol";
import {BtcHelpers} from "../../contracts/test/utils/BtcHelpers.sol";
import {PopSignatures} from "../../contracts/test/utils/PopSignatures.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {AaveCollateralLogic} from "vault-contracts/lib/aave/AaveCollateralLogic.sol";
import {IBTCVaultsManager} from "vault-contracts/interfaces/IBTCVaultsManager.sol";
import {BTCProofOfPossession} from "vault-contracts/lib/pop/BTCProofOfPossession.sol";

/// @title LiquidationE2E
/// @notice E2E script to setup a liquidatable position for the liquidation bot
/// @dev This script creates an unhealthy position and persists state so the bot can liquidate it
///      Unlike tests, scripts use vm.broadcast to persist transactions on-chain
///      This script should be run AFTER SetupEnvironment.s.sol from the contracts repo
///
/// Usage:
/// ```bash
/// # 1. First run SetupEnvironment to deploy and configure all contracts (in contracts repo)
/// cd contracts && forge script script/e2e/SetupEnvironment.s.sol:SetupEnvironment --rpc-url $RPC_URL --broadcast
///
/// # 2. Then run this script to create a liquidatable position (in liquidation bot repo)
/// cd .. && forge script test/e2e/LiquidationE2E.s.sol:LiquidationE2E --rpc-url $RPC_URL --broadcast --ffi
/// ```
contract LiquidationE2E is Script, ActionE2EPegIn, ActionE2EApplication {
    // Bot process management
    string public botProcessId;
    string public ponderProcessId;

    /// @notice Main entry point for the script
    /// @dev Overrides setUp from BaseE2ETest to use Script pattern instead of Test pattern
    function run() public {
        // Call parent setUp to load all deployed contracts and environment
        // Note: BaseE2ETest.setUp() loads contracts from DeploymentState
        setUp();

        // Load admin private key for broadcasting transactions
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");

        console.log("\n=== E2E Script Setup ===");

        // Create .env file with deployed contract addresses for bot and Ponder
        console.log("Creating .env file...");
        _createEnvFile();

        // Fund liquidator BEFORE starting bot (so bot has funds available)
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        console.log("Funding liquidator:", liquidator);

        // Use broadcast with admin to send REAL transactions visible to external RPC clients (bot)
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(liquidator, 1000 * ONE_USDC);
        wbtc.mint(liquidator, 1 * uint256(ONE_BTC));
        vm.stopBroadcast();

        // Brief pause to ensure transactions are fully processed
        vm.sleep(1000);

        // Start Ponder indexer (uses existing `pnpm indexer` script)
        console.log("Starting Ponder indexer...");
        ponderProcessId = _startPonder();

        // Wait for Ponder to be ready (listening on port 42069)
        console.log("Waiting for Ponder to start...");
        vm.sleep(10000); // 10 seconds to allow Ponder to initialize
        console.log("Ponder is ready!");

        // Start liquidation bot (uses existing `pnpm liquidate` script)
        console.log("Starting liquidation bot...");
        botProcessId = _startBot();
        console.log("=== Setup Complete ===\n");

        // Execute the liquidation scenario
        _executeLiquidationScenario(adminPrivateKey);
    }

    function _executeLiquidationScenario(uint256 adminPrivateKey) internal {
        console.log("\n=== Starting E2E Liquidation Scenario ===\n");

        // 1. Setup: Create a borrower with funds
        address borrower = vm.addr(12);

        // Fund borrower with ETH via broadcast (so external processes can see it)
        // Note: In forge script --broadcast mode, the deployer pays gas, but we fund anyway for completeness
        vm.startBroadcast(adminPrivateKey);
        payable(borrower).transfer(10 ether);
        vm.stopBroadcast();

        console.log("Borrower address:", borrower);
        console.log("Borrower ETH balance:", borrower.balance / 1e18, "ETH");

        // 2. Pegin BTC (using script-specific helper with proper broadcasting)
        console.log("\n--- Step 1: Pegin BTC ---");
        uint64 peginAmount = 10_000; // 0.0001 BTC
        bytes32 depositorBtcPubKey = PopSignatures.TEST_DEPOSITOR_BTC_PUBKEY;
        bytes32 vaultId = _doPegInScript(borrower, depositorBtcPubKey, peginAmount);
        console.log("Pegin completed, vaultId:", vm.toString(vaultId));

        // 3. Add vault as collateral to Aave position
        console.log("\n--- Step 2: Add Collateral ---");
        bytes32[] memory vaultIds = new bytes32[](1);
        vaultIds[0] = vaultId;
        _addVaultToPositionScript(borrower, vaultIds);
        console.log("Added vault to Aave position as collateral");

        // Setup borrow liquidity (so borrower can borrow USDC)
        _setUpBorrowLiquidityScript();

        // 4. Borrow USDC against the collateral
        // At 0.0001 BTC (~$5 at $50k) with 75% LTV, can borrow ~$3.75 USDC
        // Borrow $3 USDC to get close to max LTV
        console.log("\n--- Step 3: Borrow USDC ---");
        uint256 borrowAmount = 3 * ONE_USDC; // 3 USDC (~80% of max borrowable)
        _borrowFromPositionScript(borrower, borrowAmount, borrower);
        console.log("Borrowed USDC:", borrowAmount / ONE_USDC, "USDC");

        // Check position is healthy
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        console.log("\n--- Position Before Price Drop ---");
        console.log("Collateral value:", collateralBefore);
        console.log("Debt value:", debtBefore);
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100"); // Display as percentage
        require(healthFactorBefore > 1e18, "Position should be healthy initially");

        // Get liquidator and borrower info
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        address borrowerProxy = _getUserProxyAddress(borrower);
        uint256 liquidatorUsdcBefore = usdc.balanceOf(liquidator);

        console.log("\n--- Step 4: Check Liquidator Balances ---");
        console.log("Liquidator address:", liquidator);
        console.log("Borrower proxy address:", borrowerProxy);
        console.log("Liquidator USDC balance:", liquidatorUsdcBefore / ONE_USDC);
        console.log("Liquidator WBTC balance:", wbtc.balanceOf(liquidator) / ONE_BTC);

        // 5. Simulate price drop to make position unhealthy
        console.log("\n--- Step 5: Price Drop ---");
        vm.startBroadcast(adminPrivateKey);
        btcPriceFeed.simulatePriceDrop(40); // 40% price drop ($50k -> $30k)
        vm.stopBroadcast();
        console.log("BTC price dropped by 40% ($50k -> $30k)");

        // Verify position is now unhealthy
        (,, uint256 healthFactorAfterDrop) = _getPositionInfo(borrower);
        console.log("Health Factor after drop:", healthFactorAfterDrop / 1e16, "/ 100");
        require(healthFactorAfterDrop < 1e18, "Position should be unhealthy after price drop");

        // 6. Wait for Ponder to index the position changes, then wait for bot to liquidate
        // Ponder polling: 1s, Bot polling: 1s
        // Need time for: Ponder to detect price change -> Bot to poll Ponder -> Bot to execute
        console.log("\n--- Step 6: Wait for Bot Liquidation ---");
        console.log("Waiting 15 seconds for Ponder sync + bot liquidation...");
        vm.sleep(15000); // 15 seconds

        // 7. Verify position was liquidated by checking on-chain state
        console.log("\n--- Step 7: Verify Liquidation ---");
        (uint256 collateralAfter, uint256 debtAfter, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        console.log("Collateral value after:", collateralAfter);
        console.log("Debt value after:", debtAfter);
        console.log("Health Factor after:", healthFactorAfter / 1e16, "/ 100");

        // Verify debt was reduced (position was liquidated)
        require(debtAfter < debtBefore, "Debt should decrease after liquidation");
        console.log("Debt reduced by:", (debtBefore - debtAfter) / 1e26, "USD");

        // Verify collateral was reduced (collateral was seized)
        require(collateralAfter < collateralBefore, "Collateral should decrease after liquidation");
        console.log("Collateral reduced by:", (collateralBefore - collateralAfter) / 1e26, "USD");

        // 8. Verify liquidation keeper received fairness payment
        uint256 liquidatorUsdcAfter = usdc.balanceOf(liquidator);
        console.log("\n--- Step 8: Verify Keeper Payment ---");
        console.log("Liquidator USDC balance after:", liquidatorUsdcAfter / ONE_USDC);
        require(liquidatorUsdcAfter > liquidatorUsdcBefore, "Keeper should receive fairness payment");
        console.log("Keeper received:", (liquidatorUsdcAfter - liquidatorUsdcBefore) / ONE_USDC, "USDC");

        console.log("\n=== E2E Liquidation Scenario PASSED ===\n");

        // Cleanup: Kill bot and ponder processes
        _cleanup();
    }

    // ============ Helper Functions (Override to use broadcast instead of prank) ============

    /// @notice Script-specific pegin flow with proper broadcasting for each transaction
    /// @dev Breaks down the pegin process to broadcast each step with the correct signer:
    ///      - Borrower broadcasts pegin request
    ///      - Vault provider broadcasts ACKs
    ///      - Vault provider broadcasts inclusion proof submission
    function _doPegInScript(address depositor, bytes32 depositorBtcPubKey, uint256 amountSats)
        internal
        returns (bytes32 vaultId)
    {
        // Step 1: Generate unsigned pegin transaction
        bytes32 vaultProviderBtcKey = vaultManager.getVaultProviderBTCKey(vp);
        bytes memory btcPopSignature =
            PopSignatures.getBip322P2wpkh(vm, depositorBtcPubKey, BTCProofOfPossession.ACTION_PEGIN);
        (bytes memory unsignedPeginTx, string memory prevoutTxid, uint32 prevoutVout, uint64 utxoAmount) =
            _generateUnsignedPeginTx(depositorBtcPubKey, vaultProviderBtcKey, uint64(amountSats), address(aaveController));

        // Step 2: Submit pegin request (broadcast with depositor)
        vm.startBroadcast(depositor);
        vaultId = vaultManager.submitPeginRequest(depositor, depositorBtcPubKey, btcPopSignature, unsignedPeginTx, vp);
        vm.stopBroadcast();

        console.log("  Pegin request submitted, vaultId:", vm.toString(vaultId));
        require(vaultId != bytes32(0), "Vault ID should not be zero");

        // Step 3: Collect ACKs (broadcast with vault provider internally)
        _collectPeginACKs(vaultId);
        console.log("  ACKs collected from vault provider, keepers, and challengers");

        // Step 4: Sign and broadcast pegin transaction to Bitcoin
        string memory txid = _signAndBroadcastPeginTx(unsignedPeginTx, depositorBtcPubKey, prevoutTxid, prevoutVout, utxoAmount);
        console.log("  BTC transaction broadcasted with txid:", txid);

        // Step 5: Submit inclusion proof and activate vault (broadcast with vault provider)
        // Note: These are permissionless functions - using VP for semantic consistency
        vm.startBroadcast(vpPrivKey);
        _submitInclusionProofAndActivateVault(vaultId, txid);
        vm.stopBroadcast();
        console.log("  Vault activated on-chain");

        return vaultId;
    }

    /// @notice Script-specific version of _addVaultToPosition with broadcast
    function _addVaultToPositionScript(address depositor, bytes32[] memory vaultIds) internal {
        vm.startBroadcast(depositor);
        aaveController.addCollateralToCorePosition(vaultIds, vaultBtcId);
        vm.stopBroadcast();

        // Verify collateral was added
        uint256 amountSupplied = 0;
        for (uint256 i = 0; i < vaultIds.length; i++) {
            IBTCVaultsManager.BTCVault memory vault = vaultManager.getBTCVault(vaultIds[i]);
            amountSupplied += vault.amount;
        }

        require(
            aaveSpoke.getUserSuppliedAssets(vaultBtcId, _getUserProxyAddress(depositor)) == amountSupplied,
            "collateral amount mismatched"
        );

        (bool isCol, bool isBor) = aaveSpoke.getUserReserveStatus(vaultBtcId, _getUserProxyAddress(depositor));
        require(isCol, "collateral status mismatched");
        require(!isBor, "borrow status mismatched");
    }

    /// @notice Script-specific version of _borrowFromPosition with broadcast
    function _borrowFromPositionScript(address borrower, uint256 amountUsdc, address receiver) internal {
        uint256 balanceBefore = usdc.balanceOf(receiver);

        vm.startBroadcast(borrower);
        bytes32 positionId = AaveCollateralLogic.getPositionKey(borrower, vaultBtcId);
        aaveController.borrowFromCorePosition(positionId, usdcId, amountUsdc, receiver);
        vm.stopBroadcast();

        uint256 balanceAfter = usdc.balanceOf(receiver);
        require(balanceAfter - balanceBefore == amountUsdc, "received amount mismatched");
    }

    /// @notice Script-specific version of _setUpBorrowLiquidity with broadcast
    /// @dev Simplified: admin mints and supplies directly instead of using separate random user
    function _setUpBorrowLiquidityScript() internal {
        uint256 amountToSupply = ONE_USDC * 1_000_000;
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");

        // Admin mints to self and supplies to Aave (creates borrow liquidity)
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(admin, amountToSupply);
        usdc.approve(address(aaveSpoke), amountToSupply);
        aaveSpoke.supply(usdcId, amountToSupply, admin);
        vm.stopBroadcast();
    }

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
        // Start Ponder with explicit env vars from .env file
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        // Use subshell to ensure proper backgrounding and PID capture
        inputs[2] = "{ set -a; [ -f .env ] && . .env; set +a; pnpm indexer > /tmp/ponder.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);

        // Convert PID from FFI bytes to string
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Ponder started with PID:", pid);
        return pid;
    }

    function _startBot() internal returns (string memory) {
        // Start bot with explicit env vars from .env file
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        // Use subshell to ensure proper backgrounding and PID capture
        inputs[2] = "{ set -a; [ -f .env ] && . .env; set +a; pnpm liquidate > /tmp/bot.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);

        // Convert PID from FFI bytes to string using BtcHelpers utility
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Bot started with PID:", pid);
        return pid;
    }

    function _getPositionInfo(address user)
        internal
        view
        returns (uint256 totalCollateral, uint256 totalDebt, uint256 healthFactor)
    {
        // Get user's proxy address (Aave positions use proxy contracts)
        address proxy = _getUserProxyAddress(user);

        // Query Aave spoke for user's complete account data
        ISpoke.UserAccountData memory accountData = aaveSpoke.getUserAccountData(proxy);

        return (accountData.totalCollateralValue, accountData.totalDebtValue, accountData.healthFactor);
    }

    function _cleanup() internal {
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
