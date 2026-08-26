// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ArbitrageRouter} from "../../contracts/ArbitrageRouter.sol";
import {SelfCallRelayer} from "../../contracts/base/SelfCallRelayer.sol";

/// @title ArbitrageRouterRelayTest
/// @notice Covers who may submit a relayed batch.
/// @dev The submitter check runs before signature recovery, so both cases below are decided without a
///      valid signature, an LLP, or WBTC: the revert string says which check the call reached. That is the
///      whole property under test — an authorization the bot leaks while estimating gas must be inert in
///      anyone else's hands.
contract ArbitrageRouterRelayTest is Test {
    ArbitrageRouter internal router;

    address internal signer = address(0xB0B);
    address internal payer = address(0xFEE);
    address internal wbtc = address(0xC0FFEE);

    function setUp() public {
        router = new ArbitrageRouter(signer, payer, wbtc);
    }

    /// @dev One well-formed but unsigned batch. `relay` never reaches its contents in these tests.
    function _message() internal view returns (SelfCallRelayer.RelayerMessage memory message) {
        SelfCallRelayer.Call[] memory calls = new SelfCallRelayer.Call[](1);
        calls[0] = SelfCallRelayer.Call({
            data: abi.encodeCall(
                ArbitrageRouter.swapWbtcToVault, (address(0xA), bytes32(uint256(1)), address(0xB), 0, 1)
            ),
            value: 0
        });
        message = SelfCallRelayer.RelayerMessage({calls: calls, deadline: block.timestamp + 1});
    }

    function test_relay_rejectsSubmitterOtherThanSigner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("ArbitrageRouter: unauthorized submitter");
        router.relay(_message(), hex"");
    }

    /// @dev The signer gets past the submitter check and is stopped by signature recovery instead.
    function test_relay_admitsSigner() public {
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        router.relay(_message(), hex"");
    }
}
