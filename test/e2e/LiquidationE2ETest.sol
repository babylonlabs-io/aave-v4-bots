// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {ActionE2EPegIn} from "../../contracts/test/e2e/action/ActionE2EPegIn.sol";
import {ActionE2EApplication} from "../../contracts/test/e2e/action/ActionE2EApplication.sol";
import {BtcHelpers} from "../../contracts/test/utils/BtcHelpers.sol";
import {PopSignatures} from "../../contracts/test/utils/PopSignatures.sol";
import {console} from "forge-std/console.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";

contract LiquidationE2ETest is ActionE2EPegIn, ActionE2EApplication {
    // Bot process management
    string public botProcessId;
    string public ponderProcessId;

    function setUp() public override {
        super.setUp(); // Load deployed contracts from DeploymentState

        console.log("\n=== E2E Test Setup ===");

        // Create .env file with deployed contract addresses
        console.log("Creating .env file...");
        _createEnvFile();

        // Fund liquidator BEFORE starting bot (so bot has funds available)
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        console.log("Funding liquidator:", liquidator);
        vm.startPrank(admin);
        usdc.mint(liquidator, 1000 * ONE_USDC);
        wbtc.mint(liquidator, 1 * uint256(ONE_BTC));
        vm.stopPrank();
        console.log("Liquidator funded with 1000 USDC and 1 WBTC");

        // Start Ponder indexer (uses existing `pnpm indexer` script)
        console.log("Starting Ponder indexer...");
        ponderProcessId = _startPonder();

        // Wait for Ponder to be ready (listening on port 42069)
        console.log("Waiting for Ponder to start...");
        _waitForPonderReady();
        console.log("Ponder is ready!");

        // Start liquidation bot (uses existing `pnpm liquidate` script)
        console.log("Starting liquidation bot...");
        botProcessId = _startBot();
        console.log("=== Setup Complete ===\n");
    }

    function test_E2E_Liquidation_UnhealthyPosition() public {
        console.log("\n=== Starting E2E Liquidation Test ===\n");

        // 1. Setup: Create a borrower with funds and liquidity
        address borrower = vm.addr(12);
        vm.deal(borrower, 10 ether);
        console.log("Borrower address:", borrower);

        // 2. Pegin BTC (using helper from ActionE2EPegIn)
        console.log("\n--- Step 1: Pegin BTC ---");
        uint64 peginAmount = 10_000; // 0.0001 BTC
        bytes32 depositorBtcPubKey = PopSignatures.TEST_DEPOSITOR_BTC_PUBKEY;
        bytes32 vaultId = _doPegIn(borrower, depositorBtcPubKey, peginAmount);
        console.log("Pegin completed, vaultId:", vm.toString(vaultId));

        // 3. Add vault as collateral to Aave position
        console.log("\n--- Step 2: Add Collateral ---");
        bytes32[] memory vaultIds = new bytes32[](1);
        vaultIds[0] = vaultId;
        _addVaultToPosition(borrower, vaultIds);
        console.log("Added vault to Aave position as collateral");

        // Setup borrow liquidity (so borrower can borrow USDC)
        _setUpBorrowLiquidity();

        // 4. Borrow USDC against the collateral
        // At 0.0001 BTC (~$5 at $50k) with 75% LTV, can borrow ~$3.75 USDC
        // Borrow $3 USDC to get close to max LTV
        console.log("\n--- Step 3: Borrow USDC ---");
        uint256 borrowAmount = 3 * ONE_USDC; // 3 USDC (~80% of max borrowable)
        _borrowFromPosition(borrower, borrowAmount, borrower);
        console.log("Borrowed USDC:", borrowAmount / ONE_USDC, "USDC");

        // Check position is healthy
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        console.log("\n--- Position Before Price Drop ---");
        console.log("Collateral value:", collateralBefore);
        console.log("Debt value:", debtBefore);
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100"); // Display as percentage
        assertTrue(healthFactorBefore > 1e18, "Position should be healthy initially");

        // Get liquidator and borrower info
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        address borrowerProxy = _getUserProxyAddress(borrower);
        uint256 liquidatorUsdcBefore = usdc.balanceOf(liquidator);

        console.log("\n--- Step 4: Check Liquidator Balances ---");
        console.log("Liquidator address:", liquidator);
        console.log("Borrower proxy address:", borrowerProxy);
        console.log("Liquidator USDC balance:", liquidatorUsdcBefore / ONE_USDC);
        console.log("Liquidator WBTC balance:", wbtc.balanceOf(liquidator) / ONE_BTC);

        // 4. Simulate price drop to make position unhealthy
        console.log("\n--- Step 3: Price Drop ---");
        vm.prank(admin);
        btcPriceFeed.simulatePriceDrop(40); // 40% price drop ($50k -> $30k)
        console.log("BTC price dropped by 40% ($50k -> $30k)");

        // Verify position is now unhealthy
        (,, uint256 healthFactorAfterDrop) = _getPositionInfo(borrower);
        console.log("Health Factor after drop:", healthFactorAfterDrop / 1e16, "/ 100");
        assertTrue(healthFactorAfterDrop < 1e18, "Position should be unhealthy after price drop");

        // 5. Wait for Ponder to index the position changes, then wait for bot to liquidate
        // Ponder polling: 1s, Bot polling: 1s
        // Need time for: Ponder to detect price change -> Bot to poll Ponder -> Bot to execute
        console.log("\n--- Step 5: Wait for Bot Liquidation ---");
        console.log("Waiting 15 seconds for Ponder sync + bot liquidation...");
        vm.sleep(15000); // 15 seconds (increased from 10s for more safety)

        // 6. Verify position was liquidated by checking on-chain state
        console.log("\n--- Step 5: Verify Liquidation ---");
        (uint256 collateralAfter, uint256 debtAfter, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        console.log("Collateral value after:", collateralAfter);
        console.log("Debt value after:", debtAfter);
        console.log("Health Factor after:", healthFactorAfter / 1e16, "/ 100");

        // Verify debt was reduced (position was liquidated)
        assertTrue(debtAfter < debtBefore, "Debt should decrease after liquidation");
        console.log("Debt reduced by:", (debtBefore - debtAfter) / 1e26, "USD");

        // Verify collateral was reduced (collateral was seized)
        assertTrue(collateralAfter < collateralBefore, "Collateral should decrease after liquidation");
        console.log("Collateral reduced by:", (collateralBefore - collateralAfter) / 1e26, "USD");

        // 7. Verify liquidation keeper received fairness payment
        uint256 liquidatorUsdcAfter = usdc.balanceOf(liquidator);
        console.log("\n--- Step 6: Verify Keeper Payment ---");
        console.log("Liquidator USDC balance after:", liquidatorUsdcAfter / ONE_USDC);
        assertTrue(liquidatorUsdcAfter > liquidatorUsdcBefore, "Keeper should receive fairness payment");
        console.log("Keeper received:", (liquidatorUsdcAfter - liquidatorUsdcBefore) / ONE_USDC, "USDC");

        console.log("\n=== E2E Liquidation Test PASSED ===\n");
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

    function tearDown() public {
        // Kill bot and ponder processes
        _killProcess(botProcessId);
        _killProcess(ponderProcessId);
    }

    function _waitForPonderReady() internal {
        // Poll Ponder /positions endpoint until ready (max 30 seconds)
        // Returns 0 if ready, 1 if timeout
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "for i in {1..30}; do ",
            "if curl -s http://localhost:42069/positions > /dev/null 2>&1; then ",
            "echo 0; exit 0; ",
            "fi; ",
            "sleep 1; ",
            "done; ",
            "echo 1"
        );

        bytes memory result = vm.ffi(inputs);

        // Convert result to uint - should be 0 (success) or 1 (timeout)
        uint256 exitCode = BtcHelpers.convertToUint256(result);

        require(exitCode == 0, "Ponder failed to start within 30 seconds");
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
