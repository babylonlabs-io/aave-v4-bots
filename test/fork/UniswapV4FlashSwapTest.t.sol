// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

import {Types} from "./base/Types.sol";
import {UniswapV4Base} from "./base/UniswapV4Base.sol";
import {Test} from "forge-std/Test.sol";
import {
    PoolKey,
    Currency,
    IHooks,
    IPoolManager
} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolInitializer_v4} from "../../lib/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {Actions} from "../../lib/v4-periphery/src/libraries/Actions.sol";
import {TickMath} from "../../lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../lib/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPositionManager} from "../../lib/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "../../lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IBTCVaultSwap} from "../../lib/tbv-contracts/src/applications/aave/interfaces/IBTCVaultSwap.sol";
import {AaveAdapter} from "../../lib/tbv-contracts/src/applications/aave/AaveAdapter.sol";
import {IAaveOracle} from "../../lib/tbv-contracts/lib/aave-v4/src/spoke/interfaces/IAaveOracle.sol";
import {LiquidationRouter, Types as LiquidationTypes} from "../../contracts/LiquidationRouter.sol";
import {UniswapV4SwapVenue} from "../../contracts/WrappedVenue/UniswapV4SwapVenue.sol";
import {TBVHelper} from "./base/TBVHelper.sol";
import {console} from "forge-std/console.sol";

contract UniswapV4FlashSwapTest is Test, UniswapV4Base, TBVHelper {
    address internal ADMIN = vm.addr(69420);

    function setUp() public {
        vm.deal(ADMIN, 100 ether);
    }

    function test_UNISWAPV4_LIQUIDATION_TESTALL() external {
        for (uint256 i = 0; i < LIQUIDATION_TESTS.length; i++) {
            Types.LiquidationTestParams memory params = LIQUIDATION_TESTS[i];
            vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

            address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());

            deal(wbtc, MORPHO_BLUE, 2 ** 96);
            _setUpUniswap(
                params.tbvContracts.debtTokens,
                _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
                wbtc
            );

            PoolKey[] memory poolKeys = _getPoolKeys();

            (LiquidationRouter router, UniswapV4SwapVenue venue) =
                _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

            // Init liquidation calldata
            LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](3);
            flashDatas[0] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: params.tbvContracts.debtTokens[0],
                swapData: abi.encode(poolKeys[0])
            });
            flashDatas[1] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: params.tbvContracts.debtTokens[1],
                swapData: abi.encode(poolKeys[1])
            });
            flashDatas[2] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.Morpho,
                venueAddress: MORPHO_BLUE,
                token: wbtc,
                swapData: abi.encode()
            });

            uint256 balanceWbtcBefore = IERC20(wbtc).balanceOf(params.liquidation.borrower);

            vm.prank(ADMIN);
            router.liquidate(
                LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
                flashDatas,
                new LiquidationTypes.SwapData[](0)
            );

            if (params.liquidation.hasFairnessPayment) {
                uint256 balanceWbtcAfter = IERC20(wbtc).balanceOf(params.liquidation.borrower);
                vm.assertGt(balanceWbtcAfter, balanceWbtcBefore, "Expected WBTC balance to increase after liquidation");
            }
        }
    }

    function test_UNISWAPV4_LIQUIDATION_TEST0() external {
        Types.LiquidationTestParams memory params = LIQUIDATION_TESTS[0];
        vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

        address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());

        _setUpUniswap(
            params.tbvContracts.debtTokens,
            _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
            wbtc
        );

        PoolKey[] memory poolKeys = _getPoolKeys();

        (LiquidationRouter router, UniswapV4SwapVenue venue) =
            _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

        // Init liquidation calldata
        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        flashDatas[0] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: params.tbvContracts.debtTokens[0],
            swapData: abi.encode(poolKeys[0])
        });
        flashDatas[1] = LiquidationTypes.FlashData({
            venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: params.tbvContracts.debtTokens[1],
            swapData: abi.encode(poolKeys[1])
        });

        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(
            router.liquidate.selector,
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: type(uint256).max}),
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
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: 0}),
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
        Types.LiquidationTestParams memory params = LIQUIDATION_TESTS[0];
        vm.createSelectFork(vm.rpcUrl(params.liquidation.network), params.liquidation.blockNumber);

        address wbtc = address(IBTCVaultSwap(params.tbvContracts.btcVaultSwap).WBTC());
        _setUpUniswap(
            params.tbvContracts.debtTokens,
            _getWbtcPriceAgainstTokens(params.tbvContracts.aaveAdapter, params.tbvContracts.debtTokens),
            wbtc
        );

        PoolKey[] memory poolKeys = _getPoolKeys();
        (LiquidationRouter router, UniswapV4SwapVenue venue) =
            _setUpRouter(params.tbvContracts.lens, params.tbvContracts.btcVaultSwap);

        LiquidationTypes.FlashData[] memory flashDatas = new LiquidationTypes.FlashData[](2);
        for (uint256 i = 0; i < 2; i++) {
            flashDatas[i] = LiquidationTypes.FlashData({
                venueType: LiquidationTypes.VenueType.UniswapV4FlashSwap,
                venueAddress: address(venue),
                token: params.tbvContracts.debtTokens[i],
                swapData: abi.encode(poolKeys[i])
            });
        }

        // Step 1 — probe, exactly as the bot does: run the liquidation with the sentinel and read
        // the realised WBTC and the venue debts back out of the deliberate revert.
        uint256 achievable = _probeAchievableProfit(router, params.liquidation.borrower, flashDatas, wbtc);
        vm.assertGt(achievable, 0, "fixture must be profitable for this test to mean anything");

        uint256 snapshot = vm.snapshotState();

        // Step 2 — a floor the liquidation clears. 20% slippage: the default the bot ships with.
        uint256 floor = (achievable * 8_000) / 10_000;
        vm.prank(ADMIN);
        uint256 profit = router.liquidate(
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: floor}),
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
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: achievable + 1}),
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
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: achievable + 1}),
            flashDatas,
            new LiquidationTypes.SwapData[](0)
        );

        // Step 5 — and a floor the liquidation does clear still passes with that balance present,
        // reporting only what this liquidation earned. The donation is swept out alongside it: the
        // router is not a vault, and leaving it there would weaken the next call's fence too.
        vm.prank(ADMIN);
        uint256 donatedProfit = router.liquidate(
            LiquidationTypes.LiquidationData({borrower: params.liquidation.borrower, minWbtcProfit: floor}),
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

    function _setUpRouter(address _lens, address _btcVaultSwap)
        internal
        returns (LiquidationRouter router, UniswapV4SwapVenue venue)
    {
        router = new LiquidationRouter(ADMIN, _lens, _btcVaultSwap);
        venue = new UniswapV4SwapVenue(UNISWAP_V4_POOL_MANAGER, address(router));
    }
}

