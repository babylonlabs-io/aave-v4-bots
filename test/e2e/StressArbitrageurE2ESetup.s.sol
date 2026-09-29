// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {ArbitrageRouter} from "../../contracts/ArbitrageRouter.sol";
import {DeployArbitrageRouter} from "../../scripts/DeployArbitrageRouter.s.sol";
import {TestKeys} from "test-utils/TestKeys.sol";
import {ArbitrageurE2ESetup} from "./ArbitrageurE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title StressArbitrageurE2ESetup
/// @notice Setup for the **nonce stress** suite: the arbitrageur running BOTH engines off one
///         signer, against two cohorts of borrowers that become liquidatable in two separate waves.
/// @dev Unlike every other suite, this one leaves the positions **healthy**. The price drops that
///      start each wave are fired by `test/e2e/scripts/stress-drive.sh`, after the bot is running
///      and after mining has been switched to interval mode — a wave only stresses the nonce
///      allocator if the bot is alive to see it and transactions can actually queue.
///
///      **Cohort calibration** (BTC = $50,000, 0.1 BTC collateral = $5,000, collateral factor 75%):
///      - A borrows 3,000 USDC — liquidatable once the price is at 60% (drop #1, −40%), since the
///        threshold there is $2,250.
///      - B borrows 1,800 USDC — still healthy at 60% (1,800 < 2,250), liquidatable at 39%
///        (drop #2, a further −35%), where the threshold is $1,462.
///      B's 1,800 holds for any liquidation threshold in [0.60, 0.92), so it does not depend on the
///      exact health-factor formula. `_assertWave1Calibration` re-checks it on the real chain
///      anyway: a mis-calibrated B would silently collapse both waves into one and the suite would
///      still pass, which is the failure mode this guard exists to prevent.
contract StressArbitrageurE2ESetup is ArbitrageurE2ESetup {
    /// Cohort sizes, env-overridable so the same suite scales from the default 4/3 up to the
    /// dozens a real mass-liquidation needs. The depositor BTC keys are cycled (see
    /// `_depositorBtcKey`), so the only ceiling is the peg-in wall-clock and the BTC regtest UTXO
    /// supply — both measured before committing to a target N.
    uint256 internal immutable COHORT_A = vm.envOr("STRESS_COHORT_A", uint256(4));
    uint256 internal immutable COHORT_B = vm.envOr("STRESS_COHORT_B", uint256(3));

    uint256 internal constant BORROW_A_USDC = 3_000;
    uint256 internal constant BORROW_B_USDC = 1_800;

    /// When set, a **standalone** liquidator service (`services/liquidator`) runs alongside the arbitrageur and its
    /// two engines, racing the arbitrageur's own liquidation engine for the same positions. Its
    /// signer (`LIQUIDATOR`) is independent, so this does NOT test nonce sharing — it tests
    /// *competitive degradation*: what the losing bot does when its liquidation reverts because the
    /// competitor got there first. It shares the arbitrageur's indexer.
    bool internal immutable RACING = vm.envOr("STRESS_RACING", false);

    /// When set, acquisitions are funded by a treasury through an {ArbitrageRouter} rather than out
    /// of the bot's own WBTC. That makes each acquisition a *signed, replayable* batch — which is
    /// what the drive script's front-run phase copies, and the only mode in which a reverted
    /// acquisition can have spent our money anyway.
    bool internal immutable ROUTER_FUNDED = vm.envOr("STRESS_ROUTER", false);

    ArbitrageRouter internal router;

    /// 0.1 BTC, matching the single-position suites (>= the 5,460,000 sat minimum peg-in).
    uint64 internal constant PEGIN_SATS = uint64(ONE_BTC / 10);

    /// The two stress modes want opposite things from the exposure cap, so it is set per mode:
    ///
    /// - nonce/chaos run: keep the inherited low cap. Saturating it is the point (assertion A8) —
    ///   it forces slot churn and a backlog behind the nonce gap.
    /// - racing run: the cap must not be the binding constraint. With a cap far below the cohort
    ///   size the gate blocks most attempts, so the bot never contests the competitor's picks and
    ///   the run observes throttling instead of competition. Sized above the whole cohort.
    function _maxInFlight() internal view override returns (uint256) {
        return RACING ? COHORT_A + COHORT_B + 5 : super._maxInFlight();
    }

    address[] internal cohortA;
    address[] internal cohortB;
    bytes32[] internal vaultIds;
    address internal _lensAddress;

    /// @dev Anvil keys 20+ — well clear of the accounts the harness already uses (deployer,
    ///      liquidator, arbitrageur/APP_OPERATOR_0, safe owner, borrower at 12).
    function _borrowerKey(uint256 i) internal pure returns (uint256) {
        return 20 + i;
    }

    /// @dev The depositor BTC key for borrower `i`, cycled over the four usable ones.
    ///
    ///      Only eight keys in `TestKeys` have a private half in `getPrivKey` (the PoP signature
    ///      needs it), and four of those are already registered to other roles by the environment:
    ///      BTC_PUBKEY_1 (vault provider), BTC_PUBKEY_2 (app operator 1), BTC_PUBKEY_ALICE (app
    ///      operator 0 — the arbitrageur's own keeper identity) and BTC_PUBKEY_CHARLIE (universal
    ///      challenger). That leaves exactly four for depositors.
    ///
    ///      Cycling is safe because a vault is identified by `peginTxHash + depositor`, not by the
    ///      BTC key: each borrower is a distinct ETH account pegging in a distinct BTC transaction,
    ///      so two borrowers sharing a key still produce distinct vaults. Without cycling, cohort
    ///      sizes would be capped at four positions in total.
    function _depositorBtcKey(uint256 i) internal pure returns (bytes32) {
        uint256 slot = i % 4;
        if (slot == 0) return TestKeys.TEST_DEPOSITOR_BTC_PUBKEY;
        if (slot == 1) return TestKeys.BTC_PUBKEY_ALICE_2;
        if (slot == 2) return TestKeys.BTC_PUBKEY_BOB;
        return TestKeys.BTC_PUBKEY_ZERO;
    }

    /// Deploy the router, fund the treasury, and have the treasury approve it. Only the treasury
    /// can grant that approval, and `prepare()` refuses to boot without it.
    function _setupExecutor(uint256 adminPrivateKey) internal override {
        if (!ROUTER_FUNDED) return;
        address treasury = vm.addr(E2EConstants.TREASURY_PRIVATE_KEY);

        vm.startBroadcast(adminPrivateKey);
        router = new DeployArbitrageRouter().deploy(arbAddr, treasury, address(wbtc));
        wbtc.mint(treasury, 50 * uint256(ONE_BTC));
        vm.stopBroadcast();

        vm.startBroadcast(E2EConstants.TREASURY_PRIVATE_KEY);
        wbtc.approve(address(router), 50 * uint256(ONE_BTC));
        vm.stopBroadcast();

        _provisionGas(treasury, 1 ether);

        // The competitor: gas to submit our authorization, and WBTC of its own to outbid us with.
        address competitor = vm.addr(E2EConstants.FRONTRUNNER_PRIVATE_KEY);
        _provisionGas(competitor, 1 ether);
        vm.startBroadcast(adminPrivateKey);
        wbtc.mint(competitor, 10 * uint256(ONE_BTC));
        vm.stopBroadcast();
        vm.startBroadcast(E2EConstants.FRONTRUNNER_PRIVATE_KEY);
        wbtc.approve(address(vaultSwap), 10 * uint256(ONE_BTC));
        vm.stopBroadcast();

        vm.writeFile(".e2e-arbitrage-router", vm.toString(address(router)));
        console.log("Treasury (payer):", treasury, "funded + approved; router:", address(router));
    }

    /// @dev `VAULT_KEEPER_ADDRESS` is mandatory under router funding — it only redeems on behalf.
    function _executionEnvLines() internal view override returns (string memory) {
        if (!ROUTER_FUNDED) return super._executionEnvLines();
        return string.concat(
            super._executionEnvLines(),
            "ARBITRAGE_FUNDING=router\n",
            "ARBITRAGE_ROUTER_ADDRESS=",
            vm.toString(address(router)),
            "\n",
            "VAULT_KEEPER_ADDRESS=",
            vm.toString(arbAddr),
            "\n"
        );
    }

    /// @dev Deferred to `stress-drive.sh`. Building seven positions keeps this script's body running
    ///      for minutes, and forge does not flush its broadcasts until the body returns — so the
    ///      Lens deploy lands long after the base class's 60s wait for pinned bytecode expires, and
    ///      the bot would boot HALTED on the code-hash guard (correctly: there really is no code
    ///      there yet). Nothing is lost by waiting, because unlike every other suite these positions
    ///      start healthy and there is no work until the drive script fires the first price drop.
    function _startBot(address) internal pure override {}

    function _createPositions(AaveAdapterLens lens) internal override {
        _lensAddress = address(lens);
        console.log("\n=== Building cohorts (A=%s, B=%s) ===", COHORT_A, COHORT_B);

        uint256 total = COHORT_A + COHORT_B;

        // Top up the bot's inventory, scaled to the cohort. Sized generously at 4x the worst-case
        // debt: every position repaid at the higher A rate, times a margin for accrued interest and
        // the acquisition leg. The base setup's fixed 10,000 USDC is sized for one position, so at
        // scale the wave would die part-way through on `ERC20InsufficientBalance` — which reads as a
        // liquidation engine that mysteriously stops.
        uint256 usdcTopUp = total * BORROW_A_USDC * 4;
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        usdc.mint(arbAddr, usdcTopUp * ONE_USDC);
        wbtc.mint(arbAddr, uint256(total) * 10 * uint256(ONE_BTC));
        vm.stopBroadcast();
        console.log("Topped up bot inventory: +%s USDC, +%s WBTC", usdcTopUp, total * 10);

        // Supply borrowable USDC + VaultSwap WBTC once for every borrower. The base supplies 1,000,000
        // USDC and 1,000 WBTC of reserve liquidity — ample for the borrow side even at 100 positions
        // (100 x 3,000 = 300k), so this does not need scaling; only the bot's own inventory above does.
        _setUpLiquidityScript();

        uint256 tStart = vm.unixTime();
        for (uint256 i = 0; i < total; i++) {
            bool isA = i < COHORT_A;
            uint256 borrowUsdc = isA ? BORROW_A_USDC : BORROW_B_USDC;
            address borrower = _createPosition(i, borrowUsdc);
            if (isA) cohortA.push(borrower);
            else cohortB.push(borrower);
        }
        uint256 elapsedMs = vm.unixTime() - tStart;
        console.log("Built %s positions in %s ms (%s ms/position)", total, elapsedMs, elapsedMs / total);

        if (RACING) _setupRacingLiquidator(total);

        // Every position must be healthy right now: the waves are fired later, by the drive script.
        for (uint256 i = 0; i < cohortA.length; i++) {
            require(!_isLiquidatable(lens, _proxyOf(cohortA[i])), "stress: cohort A must start healthy");
        }
        for (uint256 i = 0; i < cohortB.length; i++) {
            require(!_isLiquidatable(lens, _proxyOf(cohortB[i])), "stress: cohort B must start healthy");
        }
        console.log("All %s positions healthy", cohortA.length + cohortB.length);

        _writeArtifacts();
    }

    /// @dev One borrower: fund gas, peg in 0.1 BTC, borrow USDC.
    function _createPosition(uint256 i, uint256 borrowUsdc) internal returns (address borrower) {
        uint256 key = _borrowerKey(i);
        borrower = vm.addr(key);

        // Instant, like the arbitrageur's own gas: these accounts are not genesis-funded and the
        // peg-in broadcasts from them immediately.
        _provisionGas(borrower, 10 ether);

        bytes32 vaultId = _doPegInScript(key, _depositorBtcKey(i), PEGIN_SATS);
        vaultIds.push(vaultId);

        _borrowFromPositionScript(key, borrowUsdc * ONE_USDC, borrower);
        console.log("  [%s] %s borrowed %s USDC", i, borrower, borrowUsdc);
    }

    function _proxyOf(address borrower) internal view returns (address) {
        return aaveAdapter.getPosition(borrower).proxyContract;
    }

    /// @dev Fund the competing liquidator and write its env. It runs standalone (liquidation only),
    ///      AUTO, on its own `LIQUIDATOR` signer, and **shares the arbitrageur's indexer** (PONDER_URL
    ///      42070 already serves `/liquidatable-positions`) so both bots read the same feed at the
    ///      same instant — maximal contention. LLP mode, so it needs no keeper status.
    ///
    ///      The breaker is set effectively off (100) for the observation run: a reverted liquidation
    ///      (a lost race) feeds the consecutive-failure breaker, and we want to *count* those reverts
    ///      across the whole event rather than have an early halt truncate the race. The finding —
    ///      whether a realistic breaker would trip purely from losing races — is read from the count.
    function _setupRacingLiquidator(uint256 total) internal {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        usdc.mint(E2EConstants.LIQUIDATOR, total * BORROW_A_USDC * 4 * ONE_USDC);
        wbtc.mint(E2EConstants.LIQUIDATOR, uint256(total) * 10 * uint256(ONE_BTC));
        vm.stopBroadcast();
        _provisionGas(E2EConstants.LIQUIDATOR, 10 ether);

        string memory env = string.concat(
            "LIQUIDATOR_PRIVATE_KEY=",
            vm.toString(bytes32(E2EConstants.LIQUIDATOR_PRIVATE_KEY)),
            "\nPONDER_URL=",
            E2EConstants.ARBITRAGEUR_PONDER_URL, // share the arbitrageur's indexer
            "\nCLIENT_RPC_URL=",
            E2EConstants.RPC_URL,
            "\nADAPTER_ADDRESS=",
            vm.toString(address(aaveAdapter)),
            "\nLENS_ADDRESS=",
            vm.toString(_lensAddress),
            "\nWBTC_ADDRESS=",
            vm.toString(address(wbtc)),
            "\nDEBT_TOKEN_ADDRESSES=",
            vm.toString(address(usdc)),
            "\nLLP_ADDRESS=",
            vm.toString(address(vaultSwap)),
            "\nPOLLING_INTERVAL_MS=1000\n", // fast, to collide with the arbitrageur's liq engine
            "METRICS_PORT=",
            vm.toString(E2EConstants.LIQUIDATOR_METRICS_PORT),
            "\nRISK_MAX_CONSECUTIVE_FAILURES=100\n" // see docstring: off for the observation run
        );
        vm.writeFile(".env.liquidator", env);
        console.log("Racing liquidator funded + .env.liquidator written (shares arb indexer 42070)");
    }

    /// @dev Hand the drive + verify scripts everything they need. Comma-separated, matching the
    ///      one-value-per-file convention the other suites use for `.e2e-*` artifacts.
    function _writeArtifacts() internal {
        vm.writeFile(".e2e-stress-cohort-a", _join(cohortA));
        vm.writeFile(".e2e-stress-cohort-b", _join(cohortB));
        vm.writeFile(".e2e-stress-vaultids", _joinBytes32(vaultIds));
        vm.writeFile(".e2e-stress-pricefeed", vm.toString(address(btcPriceFeed)));
        vm.writeFile(".e2e-stress-lens", vm.toString(_lensAddress));
        console.log("Artifacts written (.e2e-stress-*)");
    }

    function _join(address[] storage xs) internal view returns (string memory out) {
        for (uint256 i = 0; i < xs.length; i++) {
            out = i == 0 ? vm.toString(xs[i]) : string.concat(out, ",", vm.toString(xs[i]));
        }
    }

    function _joinBytes32(bytes32[] storage xs) internal view returns (string memory out) {
        for (uint256 i = 0; i < xs.length; i++) {
            out = i == 0 ? vm.toString(xs[i]) : string.concat(out, ",", vm.toString(xs[i]));
        }
    }
}
