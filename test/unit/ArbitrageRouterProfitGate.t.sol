// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArbitrageRouter} from "../../contracts/ArbitrageRouter.sol";
import {IBTCVaultSwap} from "vault-contracts/applications/aave/interfaces/IBTCVaultSwap.sol";

/// @title ArbitrageRouterProfitGateTest
/// @notice Covers the profit check that `swapWbtcToVault` applies to the LLP preview.
/// @dev The router is pranked as itself to pass `onlySelf`. A preview that passes the profit check reaches the
///      `maxWbtcIn` check next, so a `maxWbtcIn` below the cost marks the pass without moving any token.
contract ArbitrageRouterProfitGateTest is Test {
    ArbitrageRouter internal router;

    address internal vaultSwap = address(0x5A7);
    bytes32 internal vaultId = bytes32(uint256(1));

    function setUp() public {
        router = new ArbitrageRouter(address(0xB0B), address(0xFEE), address(0xC0FFEE));
    }

    function _mockPreview(uint256 amountVault, uint256 amountWbtcToAcquire, bool isProfitable) internal {
        IBTCVaultSwap.EscrowedVaultPreviewResult[] memory previews = new IBTCVaultSwap.EscrowedVaultPreviewResult[](1);
        previews[0] = IBTCVaultSwap.EscrowedVaultPreviewResult({
            vaultId: vaultId,
            amountVault: amountVault,
            amountDebt: amountWbtcToAcquire,
            amountInterest: 0,
            amountFee: 0,
            amountWbtcToAcquire: amountWbtcToAcquire,
            isProfitable: isProfitable
        });
        vm.mockCall(
            vaultSwap, abi.encodeWithSelector(IBTCVaultSwap.previewEscrowedVaults.selector), abi.encode(previews)
        );
    }

    function _swap(uint256 minProfit, uint256 maxWbtcIn) internal {
        vm.prank(address(router));
        router.swapWbtcToVault(vaultSwap, vaultId, address(0xB), minProfit, maxWbtcIn);
    }

    function test_rejectsVaultTheLlpMarksUnprofitable() public {
        _mockPreview(100_000, 90_000, false);
        vm.expectRevert("ArbitrageRouter: insufficient profit");
        _swap(0, 0);
    }

    /// @dev A cost above the vault's BTC gives the profit message, not an arithmetic panic.
    function test_rejectsCostAboveVaultAmount() public {
        _mockPreview(90_000, 100_000, true);
        vm.expectRevert("ArbitrageRouter: insufficient profit");
        _swap(0, 0);
    }

    function test_rejectsMarginBelowMinProfit() public {
        _mockPreview(100_000, 90_000, true);
        vm.expectRevert("ArbitrageRouter: insufficient profit");
        _swap(10_001, 0);
    }

    function test_admitsMarginEqualToMinProfit() public {
        _mockPreview(100_000, 90_000, true);
        vm.expectRevert("ArbitrageRouter: exceeds maxWbtcIn");
        _swap(10_000, 89_999);
    }
}
