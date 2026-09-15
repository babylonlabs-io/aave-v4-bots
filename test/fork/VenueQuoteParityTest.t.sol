// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey, Currency, IHooks} from "../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId, PoolIdLibrary} from "../../lib/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {IV4Quoter} from "../../lib/v4-periphery/src/interfaces/IV4Quoter.sol";
import {BaseV4Quoter} from "../../lib/v4-periphery/src/base/BaseV4Quoter.sol";
import {QuoterRevert} from "../../lib/v4-periphery/src/libraries/QuoterRevert.sol";
import {VenueManager} from "../../contracts/VenueManager.sol";
import {Types} from "../../contracts/lib/Types.sol";
import {UniswapV4SwapVenue} from "../../contracts/WrappedVenue/UniswapV4SwapVenue.sol";
import {TestSuites} from "./base/TestSuites.sol";

/// @notice Drives one flash swap through `VenueManager` the way `LiquidationRouter` does: set the venue up,
///         flash-borrow from it inside the setup callback, and let the manager's own callbacks record the debt
///         and approve the venue to pull it. The harness decides nothing about what the venue takes.
contract VenueManagerHarness is VenueManager {
    struct Step {
        bool borrow;
        Types.FlashData flashData;
        uint256 amount;
    }

    /// @return debts The venue debts the swap recorded, read before the transaction ends.
    function flashSwap(Types.FlashData memory flashData, uint256 amount)
        external
        returns (Types.VenueDebt[] memory debts)
    {
        _setUpSwapVenue(flashData.venueAddress, abi.encode(Step({borrow: true, flashData: flashData, amount: amount})));
        debts = _getAllDebts();
        _clearVenueDebts();
    }

    function _resumeAfterCallback(bytes memory forwardData) internal override {
        Step memory step = abi.decode(forwardData, (Step));
        if (step.borrow) {
            _flashLoan(
                step.flashData,
                step.amount,
                abi.encode(Step({borrow: false, flashData: step.flashData, amount: step.amount}))
            );
        }
        // The second entry arrives inside the flash-swap callback with the borrowed token in hand. There is nothing
        // to do there: the callback approves the venue for its payment once this returns.
    }
}

/// @notice Holds venue ranking to what execution charges, on Ethereum mainnet.
/// @dev Ranking picks a UniswapV4 pool by the V4Quoter's exact-output input, on the premise that it is exactly the
///      WBTC `UniswapV4SwapVenue` takes when the router borrows the same amount. Nothing else checks that premise:
///      the Sepolia suites execute flash swaps but never compare them with a quote. Two real WBTC/USDC pools with
///      similar depth and different fees give ranking a real choice to make.
contract VenueQuoteParityTest is Test, TestSuites {
    using PoolIdLibrary for PoolKey;

    /// @dev A liquidation-sized USDC debt. At the pinned block it prices the two pools apart.
    uint256 internal constant QUOTE_SIZE = 50_000e6;
    /// @dev One billion USDC: past what either pool holds at the pinned block, so both must refuse it.
    uint256 internal constant BEYOND_DEPTH = 1e15;

    VenueManagerHarness internal harness;
    UniswapV4SwapVenue internal venue;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), MAINNET_FORK_BLOCK);
        harness = new VenueManagerHarness();
        venue = new UniswapV4SwapVenue(MAINNET_UNISWAP_V4_POOL_MANAGER, address(harness));
        deal(MAINNET_WBTC, address(harness), 100e8);
    }

    function test_VENUE_QUOTE_PARITY_TWO_POOLS() external {
        PoolKey memory tight = _usdcPool(500, 10);
        PoolKey memory wide = _usdcPool(3000, 60);

        // Both quotes before either swap: a swap moves its pool, and ranking compares the pools at one state.
        uint256 quotedTight = _quote(tight, QUOTE_SIZE);
        uint256 quotedWide = _quote(wide, QUOTE_SIZE);
        vm.assertLt(quotedTight, quotedWide, "fixture: the 500 pool must quote cheaper at the pinned block");

        uint256 snapshot = vm.snapshotState();
        uint256 paidTight = _execute(tight, QUOTE_SIZE);
        vm.revertToState(snapshot);
        uint256 paidWide = _execute(wide, QUOTE_SIZE);

        vm.assertEq(paidTight, quotedTight, "the 500 pool must charge exactly its quote");
        vm.assertEq(paidWide, quotedWide, "the 3000 pool must charge exactly its quote");
    }

    function test_VENUE_QUOTE_PARITY_BEYOND_DEPTH() external {
        PoolKey[2] memory pools = [_usdcPool(500, 10), _usdcPool(3000, 60)];
        for (uint256 i = 0; i < pools.length; i++) {
            // The one quoter failure ranking reads as "cannot fill", wrapped the way it reaches the bot.
            bytes memory notEnoughLiquidity =
                abi.encodeWithSelector(BaseV4Quoter.NotEnoughLiquidity.selector, PoolId.unwrap(pools[i].toId()));
            vm.expectRevert(abi.encodeWithSelector(QuoterRevert.UnexpectedRevertBytes.selector, notEnoughLiquidity));
            _quote(pools[i], BEYOND_DEPTH);

            // And the venue refuses the same size, so an unavailable quote never hides a fillable swap.
            vm.expectRevert();
            harness.flashSwap(_flashData(pools[i]), BEYOND_DEPTH);
        }
    }

    function _usdcPool(uint24 fee, int24 tickSpacing) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(MAINNET_WBTC),
            currency1: Currency.wrap(MAINNET_USDC),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
    }

    /// @dev Exactly as the bot quotes: borrowing currency1 is zeroForOne, and the venue passes empty hook data.
    function _quote(PoolKey memory key, uint256 amount) internal returns (uint256 amountIn) {
        (amountIn,) = IV4Quoter(MAINNET_UNISWAP_V4_QUOTER)
            .quoteExactOutputSingle(
                IV4Quoter.QuoteExactSingleParams({
                poolKey: key, zeroForOne: true, exactAmount: uint128(amount), hookData: ""
            })
            );
    }

    function _flashData(PoolKey memory key) internal view returns (Types.FlashData memory) {
        return Types.FlashData({
            venueType: Types.VenueType.UniswapV4FlashSwap,
            venueAddress: address(venue),
            token: MAINNET_USDC,
            swapData: abi.encode(key)
        });
    }

    /// @return paid The WBTC the venue took for `amount` of USDC.
    function _execute(PoolKey memory key, uint256 amount) internal returns (uint256 paid) {
        uint256 wbtcBefore = IERC20(MAINNET_WBTC).balanceOf(address(harness));
        uint256 usdcBefore = IERC20(MAINNET_USDC).balanceOf(address(harness));

        Types.VenueDebt[] memory debts = harness.flashSwap(_flashData(key), amount);

        paid = wbtcBefore - IERC20(MAINNET_WBTC).balanceOf(address(harness));
        vm.assertEq(
            IERC20(MAINNET_USDC).balanceOf(address(harness)) - usdcBefore,
            amount,
            "the venue must deliver the exact amount"
        );
        vm.assertEq(debts.length, 1, "one flash swap records one debt");
        vm.assertEq(debts[0].token, MAINNET_WBTC, "the debt must be WBTC-denominated");
        vm.assertEq(debts[0].venue, address(venue), "the debt must name the venue");
        vm.assertEq(debts[0].amount, paid, "the recorded debt must be what the venue pulled");
    }
}
