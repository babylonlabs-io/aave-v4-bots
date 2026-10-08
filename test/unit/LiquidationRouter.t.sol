// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidationRouter, Types} from "../../contracts/LiquidationRouter.sol";

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
    address public immutable EXIT_BTC;

    constructor(address _exitBtc) {
        EXIT_BTC = _exitBtc;
    }
}

/// @dev Exposes the helpers that size the flash loans and the adapter approvals.
contract LiquidationRouterHarness is LiquidationRouter {
    constructor(address lens, address vaultSwap) LiquidationRouter(msg.sender, lens, vaultSwap) {}

    function paymentIn(Types.LiquidationIteration memory iteration, address token) external view returns (uint256) {
        return _paymentIn(iteration, token);
    }

    function approveForAdapter(Types.LiquidationIteration memory iteration) external {
        _approveForAdapter(iteration, iteration.reserveTokens[iteration.debtReserveId]);
    }

    function revokeApprovalForAdapter(Types.LiquidationIteration memory iteration) external {
        _revokeApprovalForAdapter(iteration.reserveTokens[iteration.debtReserveId]);
    }
}

/// @title LiquidationRouterTest
/// @notice The router pays the debt token and the WBTC fairness payment. When the borrower owes WBTC, both are one
///         token, so it must be borrowed and approved as one summed amount: an approval replaces an allowance.
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

    /// @dev Reserve 0 is the vaultBTC collateral, reserve 1 USDC, reserve 2 WBTC.
    function _iteration(uint256 debtReserveId, uint256 debtToCover, uint256 wbtcPayment)
        internal
        view
        returns (Types.LiquidationIteration memory iteration)
    {
        address[] memory reserveTokens = new address[](3);
        reserveTokens[0] = address(0xB7C);
        reserveTokens[1] = address(usdc);
        reserveTokens[2] = address(wbtc);
        iteration.debtReserveId = debtReserveId;
        iteration.debtToCover = debtToCover;
        iteration.wbtcPayment = wbtcPayment;
        iteration.reserveTokens = reserveTokens;
    }

    function test_paymentIn_splitsDebtAndFairnessPaymentByToken() public view {
        Types.LiquidationIteration memory iteration = _iteration(1, 20, 3);
        assertEq(router.paymentIn(iteration, address(usdc)), 20);
        assertEq(router.paymentIn(iteration, address(wbtc)), 3);
        assertEq(router.paymentIn(iteration, address(0xB7C)), 0);
    }

    function test_paymentIn_sumsWhenTheDebtIsWbtc() public view {
        Types.LiquidationIteration memory iteration = _iteration(2, 20, 3);
        assertEq(router.paymentIn(iteration, address(wbtc)), 23);
        assertEq(router.paymentIn(iteration, address(usdc)), 0);
    }

    function test_approveForAdapter_approvesDebtTokenAndWbtcSeparately() public {
        Types.LiquidationIteration memory iteration = _iteration(1, 20, 3);

        vm.expectCall(address(usdc), abi.encodeCall(IERC20.approve, (adapter, 20)), 1);
        vm.expectCall(address(wbtc), abi.encodeCall(IERC20.approve, (adapter, 3)), 1);
        router.approveForAdapter(iteration);

        assertEq(usdc.allowance(address(router), adapter), 20);
        assertEq(wbtc.allowance(address(router), adapter), 3);

        router.revokeApprovalForAdapter(iteration);
        assertEq(usdc.allowance(address(router), adapter), 0);
        assertEq(wbtc.allowance(address(router), adapter), 0);
    }

    function test_approveForAdapter_approvesWbtcOnceForTheSumWhenTheDebtIsWbtc() public {
        Types.LiquidationIteration memory iteration = _iteration(2, 20, 3);

        vm.expectCall(address(wbtc), abi.encodeCall(IERC20.approve, (adapter, 23)), 1);
        router.approveForAdapter(iteration);

        assertEq(wbtc.allowance(address(router), adapter), 23);

        router.revokeApprovalForAdapter(iteration);
        assertEq(wbtc.allowance(address(router), adapter), 0);
    }
}
