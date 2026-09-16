// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidationRouter} from "../../contracts/LiquidationRouter.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test", "TST") {}
}

/// @dev Answers the reads `LiquidationRouter`'s constructor makes of the lens.
contract LensStub {
    address public immutable adapter;
    address public immutable spoke;
    uint256 public constant vaultBtcReserveId = 0;

    constructor(address _adapter, address _spoke) {
        adapter = _adapter;
        spoke = _spoke;
    }
}

/// @dev Answers the read `LiquidationRouter`'s constructor makes of the BTC vault swap.
contract VaultSwapStub {
    address public immutable WBTC;

    constructor(address _wbtc) {
        WBTC = _wbtc;
    }
}

/// @dev Exposes the helpers that turn per-reserve debts into per-token amounts.
contract LiquidationRouterHarness is LiquidationRouter {
    constructor(address lens, address vaultSwap) LiquidationRouter(msg.sender, lens, vaultSwap) {}

    function reserveDebtAmount(address[] memory tokens, uint256[] memory debts, address token)
        external
        pure
        returns (uint256)
    {
        return _getReserveDebtAmount(tokens, debts, token);
    }

    function approveForAdapter(address[] memory tokens, uint256[] memory payments, uint256 wbtcPayment) external {
        _approveForAdapter(tokens, payments, wbtcPayment);
    }
}

/// @title LiquidationRouterTest
/// @notice Reserves that share an underlying (one token listed from two Hubs) must be borrowed and approved as one
///         summed amount per token: the adapter pulls that token once, for the sum over its reserves.
contract LiquidationRouterTest is Test {
    LiquidationRouterHarness internal router;
    TestToken internal usdc;
    TestToken internal wbtc;
    address internal adapter = address(0xADA);

    function setUp() public {
        usdc = new TestToken();
        wbtc = new TestToken();
        LensStub lens = new LensStub(adapter, address(0x5B0));
        router = new LiquidationRouterHarness(address(lens), address(new VaultSwapStub(address(wbtc))));
    }

    function _pair(address a, address b) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = a;
        tokens[1] = b;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = a;
        amounts[1] = b;
    }

    function test_reserveDebtAmount_sumsReservesSharingAnUnderlying() public view {
        address[] memory tokens = _pair(address(usdc), address(usdc));
        assertEq(router.reserveDebtAmount(tokens, _amounts(20, 10), address(usdc)), 30);
        // The first reserve for the token carries no debt; the second one still counts.
        assertEq(router.reserveDebtAmount(tokens, _amounts(0, 10), address(usdc)), 10);
    }

    function test_approveForAdapter_approvesEachTokenOnceForTheSum() public {
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(wbtc);
        tokens[2] = address(usdc);
        uint256[] memory payments = new uint256[](3);
        payments[0] = 20;
        payments[1] = 5;
        payments[2] = 10;

        vm.expectCall(address(usdc), abi.encodeCall(IERC20.approve, (adapter, 30)), 1);
        vm.expectCall(address(wbtc), abi.encodeCall(IERC20.approve, (adapter, 8)), 1);
        router.approveForAdapter(tokens, payments, 3);

        assertEq(usdc.allowance(address(router), adapter), 30);
        assertEq(wbtc.allowance(address(router), adapter), 8);
    }

    function test_approveForAdapter_addsWbtcPaymentOnceWhenWbtcIsListedTwice() public {
        router.approveForAdapter(_pair(address(wbtc), address(wbtc)), _amounts(4, 6), 3);

        assertEq(wbtc.allowance(address(router), adapter), 13);
    }
}
