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

/// @dev A UniswapV4 venue that needs setup and refuses it, so a test can see whether setup was attempted.
contract SetupRefusingVenueStub {
    function requireSetup() external pure returns (bool) {
        return true;
    }

    function setUp(bytes calldata) external pure {
        revert("setUp called");
    }
}

/// @dev Exposes the helpers that size the flash loans and the adapter approvals, and one Setup step.
contract LiquidationRouterHarness is LiquidationRouter {
    /// @dev The phase the state machine moved to after the last step this harness ran.
    Types.LiquidationPhase public advancedTo;
    /// @dev The venue index the state machine moved to after the last step this harness ran.
    uint256 public advancedToIndex;

    constructor(address lens, address vaultSwap) LiquidationRouter(msg.sender, lens, vaultSwap) {}

    function runSetupStep(Types.LiquidationIteration memory iteration) external {
        _executeSingleSetupPhase(iteration);
    }

    /// @dev Records the next step instead of running it.
    function _iterateLiquidation(Types.LiquidationIteration memory iteration) internal override {
        advancedTo = iteration.phase;
        advancedToIndex = iteration.i;
    }

    function paymentIn(Types.LiquidationIteration memory iteration, address token) external view returns (uint256) {
        return _paymentIn(iteration, token);
    }

    function approveForAdapter(Types.LiquidationIteration memory iteration) external {
        _approveForAdapter(iteration, iteration.debtToken);
    }

    function revokeApprovalForAdapter(Types.LiquidationIteration memory iteration) external {
        _revokeApprovalForAdapter(iteration.debtToken);
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

    function _iteration(address debtToken, uint256 debtToCover, uint256 wbtcPayment)
        internal
        pure
        returns (Types.LiquidationIteration memory iteration)
    {
        iteration.debtToken = debtToken;
        iteration.debtToCover = debtToCover;
        iteration.wbtcPayment = wbtcPayment;
    }

    /// @dev A Setup-phase iteration over two UniswapV4 venues, the first for `token`.
    function _setupIteration(address token, uint256 debtToCover, uint256 wbtcPayment)
        internal
        returns (Types.LiquidationIteration memory iteration)
    {
        iteration = _iteration(address(usdc), debtToCover, wbtcPayment);
        iteration.phase = Types.LiquidationPhase.Setup;
        iteration.flashDatas = new Types.FlashData[](2);
        address venue = address(new SetupRefusingVenueStub());
        iteration.flashDatas[0] = Types.FlashData({
            venueType: Types.VenueType.UniswapV4FlashSwap, venueAddress: venue, token: token, swapData: ""
        });
        iteration.flashDatas[1] = iteration.flashDatas[0];
    }

    function test_setupPhase_skipsAVenueWhoseTokenIsOwedNothing() public {
        // The debt is USDC and there is no fairness payment, so a WBTC venue is never drawn on.
        router.runSetupStep(_setupIteration(address(wbtc), 20, 0));

        assertEq(uint256(router.advancedTo()), uint256(Types.LiquidationPhase.Setup));
        assertEq(router.advancedToIndex(), 1);
    }

    function test_setupPhase_setsUpAVenueWhoseTokenIsOwed() public {
        Types.LiquidationIteration memory iteration = _setupIteration(address(usdc), 20, 0);

        vm.expectRevert(bytes("setUp called"));
        router.runSetupStep(iteration);
    }

    function test_paymentIn_splitsDebtAndFairnessPaymentByToken() public view {
        Types.LiquidationIteration memory iteration = _iteration(address(usdc), 20, 3);
        assertEq(router.paymentIn(iteration, address(usdc)), 20);
        assertEq(router.paymentIn(iteration, address(wbtc)), 3);
        assertEq(router.paymentIn(iteration, address(0xB7C)), 0);
    }

    function test_paymentIn_sumsWhenTheDebtIsWbtc() public view {
        Types.LiquidationIteration memory iteration = _iteration(address(wbtc), 20, 3);
        assertEq(router.paymentIn(iteration, address(wbtc)), 23);
        assertEq(router.paymentIn(iteration, address(usdc)), 0);
    }

    function test_approveForAdapter_approvesDebtTokenAndWbtcSeparately() public {
        Types.LiquidationIteration memory iteration = _iteration(address(usdc), 20, 3);

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
        Types.LiquidationIteration memory iteration = _iteration(address(wbtc), 20, 3);

        vm.expectCall(address(wbtc), abi.encodeCall(IERC20.approve, (adapter, 23)), 1);
        router.approveForAdapter(iteration);

        assertEq(wbtc.allowance(address(router), adapter), 23);

        router.revokeApprovalForAdapter(iteration);
        assertEq(wbtc.allowance(address(router), adapter), 0);
    }
}
