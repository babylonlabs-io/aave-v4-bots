// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAllowanceTransfer} from "../../../lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPoolInitializer_v4} from "../../../lib/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {IPositionManager} from "../../../lib/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "../../../lib/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "../../../lib/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {TickMath} from "../../../lib/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {PoolKey, Currency, IHooks} from "../../../lib/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {LiquidationRouter} from "../../../contracts/LiquidationRouter.sol";
import {UniswapV4SwapVenue} from "../../../contracts/WrappedVenue/UniswapV4SwapVenue.sol";

/// @dev The suite's tokens are its own mocks, so seeding a venue is a mint rather than a storage poke.
interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title FlashVenueSetup
/// @notice Stands up the flash-funding side of the e2e: a UniswapV4 pool per debt token, plus the
///         router and venue the bot drives.
/// @dev    Only usable when the suite runs against a fork (`E2E_FORK_URL`), because it uses the
///         *real* UniswapV4 deployment — PoolManager, PositionManager and Permit2 — rather than
///         standing up a mock. That is the point: the flash swap is where the interesting behaviour
///         lives (pricing, the counter-currency debt, the callback nesting), so it runs against the
///         real thing, and only the surrounding protocol is ours.
///
///         Unlike the fork *tests*, this runs as a broadcast script against a live anvil, so it
///         cannot use `deal`. It does not need to: the suite's tokens are its own mocks, so pool
///         liquidity is just a `mint`.
abstract contract FlashVenueSetup {
    /// @dev The real UniswapV4 deployment on the forked chain.
    address internal constant UNISWAP_V4_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant UNISWAP_V4_POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev The real Morpho Blue deployment — the same one the fork tests flash-borrow from.
    address internal constant MORPHO_BLUE = 0xd011EE229E7459ba1ddd22631eF7bF528d424A14;

    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /// @notice A WBTC/`token` pool, seeded deep enough that the liquidation's swap barely moves it.
    /// @dev Depth matters for more than realism: the flash swap fills at the extreme tick, so a thin
    ///      pool would price the liquidation badly and the bot would correctly decline it — the
    ///      suite would then fail for an economic reason, looking like a wiring bug.
    /// @param wbtcPerToken WBTC sats per whole `token`, i.e. the oracle price the pool should track.
    function _seedPool(address wbtc, address token, uint256 wbtcPerToken, address owner)
        internal
        returns (PoolKey memory poolKey)
    {
        (address c0, address c1) = wbtc < token ? (wbtc, token) : (token, wbtc);
        uint256 tokenUnit = 10 ** IERC20Metadata(token).decimals();

        // 100 WBTC and the matching value of the debt token, so the pool is far larger than any
        // single liquidation.
        uint256 amountWbtc = 100 * 1e8;
        uint256 amountToken = (amountWbtc * tokenUnit) / wbtcPerToken;

        uint160 sqrtPriceX96 =
            c0 == wbtc ? _encodeSqrtRatioX96(amountToken, amountWbtc) : _encodeSqrtRatioX96(amountWbtc, amountToken);

        poolKey = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        int24 tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        (uint256 amount0, uint256 amount1) = c0 == wbtc ? (amountWbtc, amountToken) : (amountToken, amountWbtc);

        uint256 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encodeWithSelector(IPoolInitializer_v4.initializePool.selector, poolKey, sqrtPriceX96);

        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(poolKey, tickLower, tickUpper, liquidity, amount0, amount1, owner, abi.encode());
        mintParams[1] = abi.encode(c0, c1);
        params[1] = abi.encodeWithSelector(
            IPositionManager.modifyLiquidities.selector,
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR)), mintParams),
            type(uint256).max
        );

        // PositionManager pulls through Permit2, so each token needs both approvals: ERC20 -> Permit2,
        // then Permit2 -> PositionManager.
        IERC20(c0).approve(PERMIT2, type(uint256).max);
        IERC20(c1).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(c0, UNISWAP_V4_POSITION_MANAGER, type(uint160).max, type(uint48).max);
        IAllowanceTransfer(PERMIT2).approve(c1, UNISWAP_V4_POSITION_MANAGER, type(uint160).max, type(uint48).max);

        IPositionManager(UNISWAP_V4_POSITION_MANAGER).multicall(params);
        console.log("  seeded WBTC pool for", IERC20Metadata(token).symbol());
    }

    /// @notice Make the real Morpho able to flash-lend this suite's WBTC.
    /// @dev Same trick as `_seedPool`: use the *real* venue and give it our mock token, rather than
    ///      standing up a fake lender. Morpho Blue's `flashLoan` transfers from its own balance and
    ///      checks no market, so a plain mint to the singleton is all it takes — no market creation,
    ///      no governance-enabled IRM/LLTV. Repayment is pulled straight back in the same call, so
    ///      the balance is only ever borrowed against, never spent.
    /// @param amount Sats to park there. Only ever needs to cover one liquidation's fairness
    ///        payment, but is sized well above that so a bigger position never runs it dry.
    function _seedMorphoWbtc(address wbtc, uint256 amount) internal {
        IMintableERC20(wbtc).mint(MORPHO_BLUE, amount);
        console.log("  seeded Morpho with WBTC (sats):", amount);
    }

    /// @notice Deploy the router the bot calls, and the venue it flash-swaps through.
    /// @param owner Must be the bot's signer: `owner` is immutable on the router and is both the only
    ///        permitted caller and the recipient of every swept balance.
    function _deployFlashContracts(address owner, address lens, address btcVaultSwap)
        internal
        returns (LiquidationRouter router, UniswapV4SwapVenue venue)
    {
        router = new LiquidationRouter(owner, lens, btcVaultSwap);
        venue = new UniswapV4SwapVenue(UNISWAP_V4_POOL_MANAGER, address(router));
        console.log("  LiquidationRouter:", address(router));
        console.log("  UniswapV4SwapVenue:", address(venue));
    }

    /// @dev `sqrt(amount1 / amount0) * 2**96`, via `sqrt(amount1 << 192 / amount0)` so the shift
    ///      happens before the division and no precision is lost to integer truncation.
    function _encodeSqrtRatioX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        return uint160(_sqrt((amount1 << 192) / amount0));
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
