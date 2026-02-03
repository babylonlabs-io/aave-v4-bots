// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "../../contracts/test/e2e/base/BaseE2E.sol";
import {BtcHelpers} from "../../contracts/test/utils/BtcHelpers.sol";
import {PopSignatures} from "../../contracts/test/utils/PopSignatures.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {AaveCollateralLogic} from "vault-contracts/lib/aave/AaveCollateralLogic.sol";
import {IBTCVaultsManager} from "vault-contracts/interfaces/IBTCVaultsManager.sol";
import {BTCProofOfPossession} from "vault-contracts/lib/pop/BTCProofOfPossession.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title LiquidationE2ESetup
/// @notice E2E script to setup a liquidatable position for the liquidation bot
/// @dev Part 1: Creates unhealthy position, starts bot/ponder, persists state
///      Run LiquidationE2EVerify.s.sol after this to verify liquidation occurred
contract LiquidationE2ESetup is Script, BaseE2E {
    uint256 constant BORROWER_PRIVATE_KEY = 12;

    /// @notice Main entry point for the setup script
    function run() public {
        // Call parent setUp to load all deployed contracts and environment
        init(vm);

        // Load admin private key for broadcasting transactions
        uint256 adminPrivateKey = vm.envUint("ADMIN_PRIVKEY");

        console.log("\n=== E2E Liquidation Setup ===");

        // Fund liquidator with USDC and WBTC
        console.log("\n--- Step 1: Fund Liquidator ---");
        address liquidator = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        vm.startBroadcast(adminPrivateKey);
        usdc.mint(liquidator, 1000 * ONE_USDC);
        wbtc.mint(liquidator, 1 * uint256(ONE_BTC));
        vm.stopBroadcast();
        console.log("Liquidator funded with 1000 USDC and 1 WBTC");

        // Create .env file with deployed contract addresses for bot and Ponder
        console.log("\n--- Step 2: Create .env File ---");
        _createEnvFile();

        // Start Ponder indexer
        console.log("\n--- Step 3: Start Ponder ---");
        string memory ponderProcessId = _startLiquidatorPonder();
        vm.sleep(10000); // Wait 10s for Ponder to initialize
        console.log("Ponder is ready!");

        // Start liquidation bot
        console.log("\n--- Step 4: Start Bot ---");
        string memory botProcessId = _startLiquidatorBot();
        console.log("Bot is ready!");

        // Create borrower and fund with ETH
        console.log("\n--- Step 5: Create Borrower ---");
        address borrower = vm.addr(BORROWER_PRIVATE_KEY);
        vm.startBroadcast(adminPrivateKey);
        payable(borrower).transfer(10 ether);
        vm.stopBroadcast();
        console.log("Borrower address:", borrower);

        // Pegin BTC
        console.log("\n--- Step 6: Pegin BTC ---");
        uint64 peginAmount = 10_000; // 0.0001 BTC
        bytes32 depositorBtcPubKey = PopSignatures.TEST_DEPOSITOR_BTC_PUBKEY;
        bytes32 vaultId = _doPegInScript(BORROWER_PRIVATE_KEY, depositorBtcPubKey, peginAmount);
        console.log("Pegin completed, vaultId:", vm.toString(vaultId));

        // Add vault as collateral
        console.log("\n--- Step 7: Add Collateral ---");
        bytes32[] memory vaultIds = new bytes32[](1);
        vaultIds[0] = vaultId;
        _addVaultToPositionScript(BORROWER_PRIVATE_KEY, vaultIds);
        console.log("Collateral added");

        // Setup liquidity (USDC for borrowing and WBTC for VaultSwap)
        console.log("\n--- Step 8: Setup Liquidity ---");
        _setUpLiquidityScript();

        // Borrow USDC
        console.log("\n--- Step 9: Borrow USDC ---");
        uint256 borrowAmount = 3 * ONE_USDC;
        _borrowFromPositionScript(BORROWER_PRIVATE_KEY, borrowAmount, borrower);
        console.log("Borrowed:", borrowAmount / ONE_USDC, "USDC");

        // Check position is healthy
        (uint256 collateralBefore, uint256 debtBefore, uint256 healthFactorBefore) = _getPositionInfo(borrower);
        console.log("\n--- Position Before Price Drop ---");
        console.log("Collateral value:", collateralBefore / 1e26, "USD");
        console.log("Debt value:", debtBefore / 1e26, "USD");
        console.log("Health Factor:", healthFactorBefore / 1e16, "/ 100");
        require(healthFactorBefore > 1e18, "Position should be healthy initially");

        // Simulate price drop
        console.log("\n--- Step 10: Price Drop ---");
        vm.startBroadcast(adminPrivateKey);
        btcPriceFeed.simulatePriceDrop(40); // 40% drop
        vm.stopBroadcast();
        console.log("BTC price dropped by 40%");

        // Verify position is now unhealthy
        (,, uint256 healthFactorAfter) = _getPositionInfo(borrower);
        console.log("Health Factor after drop:", healthFactorAfter / 1e16, "/ 100");
        require(healthFactorAfter < 1e18, "Position should be unhealthy after price drop");

        console.log("\n=== Setup Complete ===");
        console.log("Run LiquidationE2EVerify.s.sol to verify liquidation");
        console.log("Borrower address:", borrower);
        console.log("Ponder PID:", ponderProcessId);
        console.log("Bot PID:", botProcessId);
    }

    // ============ Helper Functions ============

    function _doPegInScript(uint256 depositorPrivateKey, bytes32 depositorBtcPubKey, uint256 amountSats)
        internal
        returns (bytes32 vaultId)
    {
        address depositor = vm.addr(depositorPrivateKey);
        bytes32 vaultProviderBtcKey = vaultManager.getVaultProviderBTCKey(vp);
        bytes memory btcPopSignature =
            PopSignatures.getBip322P2wpkh(vm, depositorBtcPubKey, BTCProofOfPossession.ACTION_PEGIN);
        (bytes memory unsignedPeginTx, string memory prevoutTxid, uint32 prevoutVout, uint64 utxoAmount) = _generateUnsignedPeginTx(
            depositorBtcPubKey, vaultProviderBtcKey, uint64(amountSats), address(aaveController)
        );

        vm.startBroadcast(depositorPrivateKey);
        vaultId = vaultManager.submitPeginRequest(depositor, depositorBtcPubKey, btcPopSignature, unsignedPeginTx, vp);
        vm.stopBroadcast();

        _collectPeginACKs(vaultId);
        string memory txid =
            _signAndBroadcastPeginTx(unsignedPeginTx, depositorBtcPubKey, prevoutTxid, prevoutVout, utxoAmount);

        vm.startBroadcast(vpPrivKey);
        _submitInclusionProofAndActivateVault(vaultId, txid);
        vm.stopBroadcast();

        return vaultId;
    }

    function _addVaultToPositionScript(uint256 depositorPrivateKey, bytes32[] memory vaultIds) internal {
        address depositor = vm.addr(depositorPrivateKey);
        vm.startBroadcast(depositorPrivateKey);
        aaveController.addCollateralToCorePosition(vaultIds, vaultBtcId);
        vm.stopBroadcast();

        uint256 amountSupplied = 0;
        for (uint256 i = 0; i < vaultIds.length; i++) {
            IBTCVaultsManager.BTCVault memory vault = vaultManager.getBTCVault(vaultIds[i]);
            amountSupplied += vault.amount;
        }

        require(
            aaveSpoke.getUserSuppliedAssets(vaultBtcId, _getUserProxyAddress(depositor)) == amountSupplied,
            "collateral amount mismatched"
        );
    }

    function _borrowFromPositionScript(uint256 borrowerPrivateKey, uint256 amountUsdc, address receiver) internal {
        address borrower = vm.addr(borrowerPrivateKey);
        uint256 balanceBefore = usdc.balanceOf(receiver);

        vm.startBroadcast(borrowerPrivateKey);
        bytes32 positionId = AaveCollateralLogic.getPositionKey(borrower, vaultBtcId);
        aaveController.borrowFromCorePosition(positionId, usdcId, amountUsdc, receiver);
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

    function _startLiquidatorPonder() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] =
        "{ set -a; [ -f .env ] && . .env; set +a; pnpm liquidator:indexer > /tmp/ponder.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Liquidator ponder started with PID:", pid);
        return pid;
    }

    function _startLiquidatorBot() internal returns (string memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "{ set -a; [ -f .env ] && . .env; set +a; pnpm liquidator:run > /tmp/bot.log 2>&1 & echo $!; }";
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log("Liquidator bot started with PID:", pid);
        return pid;
    }

    function _getUserProxyAddress(address user) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(user));
        return Clones.predictDeterministicAddress(address(btcVaultCoreSpokeProxyImpl), salt, address(aaveController));
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
}
