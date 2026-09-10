// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

import {Types} from "./base/Types.sol";
import {UniswapV4Base} from "./base/UniswapV4Base.sol";
import {TBVForkFixture} from "./base/TBVForkFixture.sol";
import {PoolKey} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../contracts/LiquidationRouter.sol";
import {UniswapV4SwapVenue} from "../../contracts/WrappedVenue/UniswapV4SwapVenue.sol";
import {TBVHelper} from "./base/TBVHelper.sol";

contract UniswapV4FlashSwapTest is UniswapV4Base, TBVForkFixture, TBVHelper {
    address internal ADMIN = vm.addr(69420);

    /// @dev Deliberately empty, overriding the fixture's already-empty `setUp`: the protocol is
    ///      deployed after the fork is selected, from inside each test. See `TBVForkFixture`.
    function setUp() public override {}

    /// @notice Fork, deploy, build the position, and stand the venue pools up around it.
    /// @dev Every test in this file needs the same four steps in the same order; `wbtc` is returned
    ///      because it is the token the profit is measured in and the assertions all need it.
    function _prepare(Types.LiquidationScenario memory scenario)
        internal
        returns (address who, address wbtcAddr, PoolKey[] memory poolKeys)
    {
        who = _forkAndBuild(scenario);
        vm.deal(ADMIN, 100 ether);

        address[] memory debtTokens = _debtTokens();
        wbtcAddr = address(vaultSwap.WBTC());
        _setUpUniswap(debtTokens, _getWbtcPriceAgainstTokens(address(adapter), debtTokens), wbtcAddr);
        poolKeys = _getPoolKeys();
    }

    /// @notice The two USDC/USDT flash-swap venues every scenario draws its debt from.
    function _debtFlashDatas(UniswapV4SwapVenue venue, PoolKey[] memory poolKeys)
        internal
        view
        returns (LiquidationTypes.FlashData[] memory flashDatas)
    {
        address[] memory debtTokens = _debtTokens();
        flashDatas = new LiquidationTypes.FlashData[](2);
        for (uint256 i = 0; i < 2; i++) {
            flashDatas[i] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: debtTokens[i],
                swapData: abi.encode(poolKeys[i])
            });
        }
    }

    function test_UNISWAPV4_LIQUIDATION_TESTALL() external {
        for (uint256 i = 0; i < LIQUIDATION_SCENARIOS.length; i++) {
            Types.LiquidationScenario memory scenario = LIQUIDATION_SCENARIOS[i];
            (address who, address wbtc, PoolKey[] memory poolKeys) = _prepare(scenario);

            deal(wbtc, MORPHO_BLUE, 2 ** 96);

            (LiquidationRouter router, UniswapV4SwapVenue venue) = _setUpRouter();

            // Three venues: the two debt tokens by flash swap, and WBTC by flash loan for the
            // fairness payment. The WBTC entry is passed either way — the router skips a venue whose
            // token is owed nothing, so the no-fairness scenario simply never draws on it.
            LiquidationTypes.FlashData[] memory debtDatas = _debtFlashDatas(venue, poolKeys);
            LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](3);
            flashDatas[0] = debtDatas[0];
            flashDatas[1] = debtDatas[1];
            flashDatas[2] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.Morpho,
                venueAddress: MORPHO_BLUE,
                token: wbtc,
                swapData: abi.encode()
            });

            uint256 balanceWbtcBefore = IERC20(wbtc).balanceOf(who);

            vm.prank(ADMIN);
            router.liquidate(
                LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: 0}),
                flashDatas,
                new LiquidationTypes.SwapData[](0)
            );

            // Asserted in both directions. The fairness payment is the only thing that draws on the
            // WBTC venue, so a scenario that quietly stopped producing one — or started producing one
            // where none was intended — would leave that venue untested while still passing.
            uint256 balanceWbtcAfter = IERC20(wbtc).balanceOf(who);
            if (scenario.hasFairnessPayment) {
                vm.assertGt(balanceWbtcAfter, balanceWbtcBefore, "expected a fairness payment to the borrower");
            } else {
                vm.assertEq(balanceWbtcAfter, balanceWbtcBefore, "expected no fairness payment for this scenario");
            }
        }
    }

    function test_UNISWAPV4_LIQUIDATION_TEST0() external {
        Types.LiquidationScenario memory scenario = LIQUIDATION_SCENARIOS[0];
        (address who, address wbtc, PoolKey[] memory poolKeys) = _prepare(scenario);

        (LiquidationRouter router, UniswapV4SwapVenue venue) = _setUpRouter();
        LiquidationTypes.FlashData[] memory flashDatas = _debtFlashDatas(venue, poolKeys);

        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(
            router.liquidate.selector,
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: type(uint256).max}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        // Run the revert test to gain insight into the liquidation process and the expected WBTC profit before payment
        vm.prank(ADMIN);
        (bool[] memory successes, bytes[] memory results) = router.multicall(datas, false);

        vm.assertFalse(successes[0], "Expected liquidation to fail due to BelovedError()");

        bytes memory truncData = new bytes(results[0].length - 4);
        for (uint256 i = 0; i < truncData.length; i++) {
            truncData[i] = results[0][i + 4];
        }

        (uint256 netWbtcBeforePayment, LiquidationTypes.VenueDebt[] memory venueDebts) =
            abi.decode(truncData, (uint256, LiquidationTypes.VenueDebt[]));
        uint256 sumVenueDebts = 0;

        for (uint256 i = 0; i < venueDebts.length; i++) {
            sumVenueDebts += venueDebts[i].amount;
        }

        vm.assertGt(
            netWbtcBeforePayment,
            sumVenueDebts,
            "Expected net WBTC before payment to be greater than sum of venue debts"
        );

        // Execute the liquidation
        vm.prank(ADMIN);
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: 0}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        vm.assertEq(
            IERC20(wbtc).balanceOf(ADMIN),
            netWbtcBeforePayment - sumVenueDebts,
            "Expected final WBTC balance to match net WBTC before payment minus sum of venue debts"
        );
    }

    /// @notice `minWbtcProfit` is the only thing standing between the bot and a bad fill, so prove it
    ///         actually bites — in both directions, against the real chain.
    /// @dev    The other tests in this file pass `minWbtcProfit: 0`, which can never fail the guard,
    ///         so none of them exercise it. Flash-swap funding sets its price limit to the extreme
    ///         tick (`UniswapV4SwapVenue._swapAndTake`), i.e. it fills at whatever the pool gives:
    ///         this floor is the whole of the slippage protection, and the off-chain
    ///         `minWbtcProfitFloor` derives it from the probe exactly as done here.
    function test_UNISWAPV4_LIQUIDATION_MIN_PROFIT_FLOOR() external {
        Types.LiquidationScenario memory scenario = LIQUIDATION_SCENARIOS[0];
        (address who, address wbtc, PoolKey[] memory poolKeys) = _prepare(scenario);

        (LiquidationRouter router, UniswapV4SwapVenue venue) = _setUpRouter();
        LiquidationTypes.FlashData[] memory flashDatas = _debtFlashDatas(venue, poolKeys);

        // Step 1 — probe, exactly as the bot does: run the liquidation with the sentinel and read
        // the realised WBTC and the venue debts back out of the deliberate revert.
        uint256 achievable = _probeAchievableProfit(router, who, flashDatas, wbtc);
        vm.assertGt(achievable, 0, "fixture must be profitable for this test to mean anything");

        uint256 snapshot = vm.snapshotState();

        // Step 2 — a floor the liquidation clears. 20% slippage: the default the bot ships with.
        uint256 floor = (achievable * 8_000) / 10_000;
        vm.prank(ADMIN);
        uint256 profit = router.liquidate(
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: floor}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );
        vm.assertGe(profit, floor, "liquidation returned less than the floor it was given");
        vm.assertEq(IERC20(wbtc).balanceOf(ADMIN), achievable, "profit should be swept to owner");

        vm.revertToState(snapshot);

        // Step 3 — the same liquidation, one sat above what it can actually earn. The guard must
        // reject it and leave nothing behind: this is what protects the bot when the pool has moved
        // between the probe and the mine.
        vm.prank(ADMIN);
        vm.expectRevert("LiquidationRouter: Insufficient WBTC profit");
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: achievable + 1}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );
        vm.assertEq(IERC20(wbtc).balanceOf(ADMIN), 0, "a rejected liquidation must move nothing");

        // Step 4 — the same rejected liquidation, with WBTC already sitting in the router. Nothing
        // about what this liquidation earns has changed, so the verdict must not change either.
        //
        // Measured against the closing balance it would: the donation alone clears the floor, and a
        // liquidation earning nothing at all would be accepted. Anyone can send a token to a
        // contract, so that is a guard that a stranger — or an operator's fat finger — can switch
        // off. The floor is a delta for this reason.
        deal(wbtc, address(router), achievable);
        vm.prank(ADMIN);
        vm.expectRevert("LiquidationRouter: Insufficient WBTC profit");
        router.liquidate(
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: achievable + 1}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        // Step 5 — and a floor the liquidation does clear still passes with that balance present,
        // reporting only what this liquidation earned. The donation is swept out alongside it: the
        // router is not a vault, and leaving it there would weaken the next call's fence too.
        vm.prank(ADMIN);
        uint256 donatedProfit = router.liquidate(
            LiquidationTypes.LiquidationData({borrower: who, minWbtcProfit: floor}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );
        vm.assertEq(donatedProfit, achievable, "reported profit must be the delta, not the closing balance");
        vm.assertEq(
            IERC20(wbtc).balanceOf(ADMIN), achievable * 2, "the donation is swept to owner alongside the profit"
        );
        vm.assertEq(IERC20(wbtc).balanceOf(address(router)), 0, "the router must end empty");
    }

    /// @notice The `BelovedError` probe: realised WBTC minus everything owed back to the venues.
    /// @dev Mirrors the off-chain `probeLiquidation` + `quoteProfit` pair. `multicall(.., false)`
    ///      captures the revert payload instead of letting it bubble.
    function _probeAchievableProfit(
        LiquidationRouter router,
        address borrower,
        LiquidationTypes.FlashData[] memory flashDatas,
        address wbtc
    ) internal returns (uint256) {
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(
            router.liquidate.selector,
            LiquidationTypes.LiquidationData({borrower: borrower, minWbtcProfit: type(uint256).max}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        vm.prank(ADMIN);
        (bool[] memory successes, bytes[] memory results) = router.multicall(datas, false);
        vm.assertFalse(successes[0], "probe must revert with BelovedError");

        bytes memory truncated = new bytes(results[0].length - 4);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = results[0][i + 4];
        }
        (uint256 netWbtcBeforePayment, LiquidationTypes.VenueDebt[] memory venueDebts) =
            abi.decode(truncated, (uint256, LiquidationTypes.VenueDebt[]));

        uint256 owed = 0;
        for (uint256 i = 0; i < venueDebts.length; i++) {
            // Every debt must be WBTC-denominated, or `swapDatas` would have been required.
            vm.assertEq(venueDebts[i].token, wbtc, "non-WBTC venue debt");
            owed += venueDebts[i].amount;
        }
        return netWbtcBeforePayment - owed;
    }

    function _setUpRouter() internal returns (LiquidationRouter router, UniswapV4SwapVenue venue) {
        router = new LiquidationRouter(ADMIN, address(preview), address(vaultSwap));
        venue = new UniswapV4SwapVenue(UNISWAP_V4_POOL_MANAGER, address(router));
    }
}

