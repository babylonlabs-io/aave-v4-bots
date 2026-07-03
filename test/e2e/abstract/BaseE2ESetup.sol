// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BaseE2E} from "test-e2e-base/BaseE2E.sol";
import {BtcHelpers} from "test-utils/BtcHelpers.sol";
import {PopHelpers} from "test-utils/PopHelpers.sol";
import {TestKeys} from "test-utils/TestKeys.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {E2EConstants} from "../E2EConstants.sol";

/// @title BaseE2ESetup
/// @notice Shared position lifecycle + process launching for the E2E setup
///         scripts. Concrete setups (LiquidationE2ESetup, ArbitrageurE2ESetup)
///         differ only in *who* is funded, which `.env` is written, and which
///         processes are started; the liquidatable-position setup is identical.
/// @dev Extracted so the liquidator suite (standalone liquidator bot) and the
///      arbitrageur suite (one arb bot running both engines) share one flow.
abstract contract BaseE2ESetup is Script, BaseE2E {
    bytes32 internal constant _E2E_WOTS_PK_HASH = keccak256("test_wots_key");
    bytes internal constant _E2E_DUMMY_PAYOUT_ADDRESS =
        hex"5120aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// @notice Deploy the Lens the bots use to estimate liquidations.
    function _deployLens() internal returns (AaveAdapterLens lens) {
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(adminPrivateKey);
        lens = new AaveAdapterLens(address(btcVaultRegistry), address(aaveAdapter), address(aaveSpoke), vaultBtcId);
        vm.stopBroadcast();
        console.log("Lens deployed at:", address(lens));
    }

    /// @notice Create a borrower, open a position, and drop the price so it is
    ///         liquidatable — the identical setup both suites run once the
    ///         bot(s) are already polling. Persists the vault id for verify.
    function _setupLiquidatablePosition(AaveAdapterLens lens) internal returns (address borrower, bytes32 vaultId) {
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // Create borrower and fund with ETH
        console.log("\n--- Create Borrower ---");
        borrower = vm.addr(E2EConstants.BORROWER_PRIVATE_KEY);
        vm.startBroadcast(adminPrivateKey);
        payable(borrower).transfer(10 ether);
        vm.stopBroadcast();
        console.log("Borrower address:", borrower);

        // Pegin BTC (0.1 BTC, must be >= minimumPegInAmount of 5,460,000 sats)
        console.log("\n--- Pegin BTC ---");
        uint64 peginAmount = uint64(ONE_BTC / 10);
        vaultId = _doPegInScript(E2EConstants.BORROWER_PRIVATE_KEY, TestKeys.TEST_DEPOSITOR_BTC_PUBKEY, peginAmount);
        console.log("Pegin completed, vaultId:", vm.toString(vaultId));
        _saveVaultId(vaultId);

        // Setup liquidity (USDC for borrowing and WBTC for VaultSwap)
        console.log("\n--- Setup Liquidity ---");
        _setUpLiquidityScript();

        // Borrow USDC
        console.log("\n--- Borrow USDC ---");
        uint256 borrowAmount = 3000 * ONE_USDC;
        _borrowFromPositionScript(E2EConstants.BORROWER_PRIVATE_KEY, borrowAmount, borrower);
        console.log("Borrowed:", borrowAmount / ONE_USDC, "USDC");

        // Assert healthy before the drop (Lens.estimateLiquidation reverts when healthy)
        address borrowerProxy = aaveAdapter.getPosition(borrower).proxyContract;
        require(!_isLiquidatable(lens, borrowerProxy), "Position should be healthy initially");
        console.log("Position is healthy");

        // Simulate 40% price drop → liquidatable
        console.log("\n--- Price Drop ---");
        vm.startBroadcast(adminPrivateKey);
        btcPriceFeed.simulatePriceDrop(40);
        vm.stopBroadcast();
        require(_isLiquidatable(lens, borrowerProxy), "Position should be unhealthy after price drop");
        console.log("Position is unhealthy (liquidatable)");
    }

    /// @notice Start a background bot/indexer process, sourcing `envFile`, and
    ///         return its PID. Replaces the per-service launchers.
    function _startProcess(string memory envFile, string memory pnpmScript, string memory logFile)
        internal
        returns (string memory)
    {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = string.concat(
            "{ set -a; [ -f ",
            envFile,
            " ] && . ",
            envFile,
            "; set +a; pnpm ",
            pnpmScript,
            " > ",
            logFile,
            " 2>&1 & echo $!; }"
        );
        bytes memory result = vm.ffi(inputs);
        string memory pid = vm.toString(BtcHelpers.convertToUint256(result));
        console.log(string.concat(pnpmScript, " started with PID:"), pid);
        return pid;
    }

    // ============ Shared position helpers ============

    function _doPegInScript(uint256 depositorPrivateKey, bytes32 depositorBtcPubKey, uint256 amountSats)
        internal
        returns (bytes32 vaultId)
    {
        address depositor = vm.addr(depositorPrivateKey);

        // Generate unique secret and hashlock for atomic swap
        bytes32 secret = keccak256(abi.encodePacked("e2e_liq_secret", block.number));
        bytes32 hashlock = sha256(abi.encodePacked(secret));

        bytes32 vaultProviderBtcKey = btcVaultRegistry.getVaultProviderBTCKey(vp);
        bytes memory btcPopSignature =
            PopHelpers.getBip322P2wpkh(vm, depositorBtcPubKey, PopHelpers.ACTION_PEGIN, address(btcVaultRegistry));
        (bytes memory unsignedPeginTx, string memory prevoutTxid, uint32 prevoutVout, uint64 utxoAmount) =
            _generateUnsignedPeginTx(depositorBtcPubKey, vaultProviderBtcKey, uint64(amountSats), address(aaveAdapter));

        // Get required pegin fee and fund depositor
        uint256 pegInFee = btcVaultRegistry.getPegInFee(vp);
        vm.deal(depositor, depositor.balance + pegInFee);

        vm.startBroadcast(depositorPrivateKey);
        vaultId = btcVaultRegistry.submitPeginRequest{value: pegInFee}(
            depositor,
            depositorBtcPubKey,
            btcPopSignature,
            unsignedPeginTx,
            unsignedPeginTx, // Use same tx as depositorSignedPeginTx for E2E
            vp,
            type(uint16).max, // maxAcceptableCommissionBps — accept any VP commission in E2E
            hashlock,
            0,
            _E2E_DUMMY_PAYOUT_ADDRESS,
            _E2E_WOTS_PK_HASH
        );
        vm.stopBroadcast();

        _collectPeginACKs(vaultId);
        _signAndBroadcastPeginTx(unsignedPeginTx, depositorBtcPubKey, prevoutTxid, prevoutVout, utxoAmount);

        // Activate vault with secret (atomic swap reveal)
        vm.startBroadcast(depositorPrivateKey);
        btcVaultRegistry.activateVaultWithSecret(vaultId, secret, "");
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
        uint256 adminPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

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

    function _saveVaultId(bytes32 vaultId) internal {
        vm.writeFile(".e2e-vault-id", vm.toString(vaultId));
    }

    /// @notice Check if a position is liquidatable via the Lens contract.
    /// @dev Lens.estimateLiquidation reverts when the position is healthy, succeeds when liquidatable.
    function _isLiquidatable(AaveAdapterLens lens, address borrowerProxy) internal view returns (bool) {
        try lens.estimateLiquidation(borrowerProxy, false) returns (uint256[] memory, uint256, bytes32[] memory) {
            return true;
        } catch {
            return false;
        }
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
