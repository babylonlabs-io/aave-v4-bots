// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IBTCVaultSwap} from "vault-contracts/applications/aave/interfaces/IBTCVaultSwap.sol";
import {ArbitrageRouter} from "../../contracts/ArbitrageRouter.sol";
import {SelfCallRelayer} from "../../contracts/base/SelfCallRelayer.sol";

contract RouterTestToken is ERC20 {
    constructor() ERC20("WBTC", "WBTC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RouterTestVaultSwap {
    RouterTestToken internal immutable token;
    address public lastKeeper;

    constructor(RouterTestToken token_) {
        token = token_;
    }

    function previewEscrowedVaults(bytes32[] calldata vaultIds)
        external
        pure
        returns (IBTCVaultSwap.EscrowedVaultPreviewResult[] memory previews)
    {
        previews = new IBTCVaultSwap.EscrowedVaultPreviewResult[](1);
        previews[0].vaultId = vaultIds[0];
        previews[0].amountVault = 100;
        previews[0].amountExitBtcToAcquire = 80;
        previews[0].amountProfitEst = 20;
    }

    function swapExitBtcForVaultOnBehalf(bytes32, uint256 amount, address keeper) external returns (uint256) {
        lastKeeper = keeper;
        token.transferFrom(msg.sender, address(this), amount);
        return amount;
    }
}

contract TestableArbitrageRouter is ArbitrageRouter {
    constructor(address signer_, address payer_, address wbtc_, address vaultSwap_, address keeper_)
        ArbitrageRouter(signer_, payer_, wbtc_, vaultSwap_, keeper_)
    {}

    function messageDigest(RelayerMessage memory message) external view returns (bytes32) {
        return _hashRelayerMessage_signing(message);
    }
}

/// @title ArbitrageRouterRelayTest
/// @notice Covers who may submit a relayed batch.
/// @dev The submitter check runs before signature recovery, so the revert string shows which check
///      stopped the call. A batch leaked during gas estimation must be inert for anyone but the signer.
contract ArbitrageRouterRelayTest is Test {
    ArbitrageRouter internal router;

    address internal signer = address(0xB0B);
    address internal payer = address(0xFEE);
    address internal wbtc = address(0xC0FFEE);

    function setUp() public {
        router = new ArbitrageRouter(signer, payer, wbtc, address(0xA), address(0xB));
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

contract ArbitrageRouterAddressGuardTest is Test {
    uint256 internal constant SIGNER_KEY = 0x1234;
    address internal signer;
    address internal payer = address(0xFEE);
    address internal keeper = address(0xBEEF);
    RouterTestToken internal token;
    RouterTestVaultSwap internal vaultSwap;
    TestableArbitrageRouter internal router;

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        token = new RouterTestToken();
        vaultSwap = new RouterTestVaultSwap(token);
        router = new TestableArbitrageRouter(signer, payer, address(token), address(vaultSwap), keeper);
        token.mint(payer, 100);
        vm.prank(payer);
        token.approve(address(router), 100);
    }

    function _relay(address swap, address recipient, string memory expectedRevert) internal {
        SelfCallRelayer.Call[] memory calls = new SelfCallRelayer.Call[](1);
        calls[0] = SelfCallRelayer.Call({
            data: abi.encodeCall(ArbitrageRouter.swapWbtcToVault, (swap, bytes32(uint256(1)), recipient, 20, 80)),
            value: 0
        });
        SelfCallRelayer.RelayerMessage memory message =
            SelfCallRelayer.RelayerMessage({calls: calls, deadline: block.timestamp + 1});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, router.messageDigest(message));
        if (bytes(expectedRevert).length != 0) vm.expectRevert(bytes(expectedRevert));
        vm.prank(signer);
        router.relay(message, abi.encodePacked(r, s, v));
    }

    function test_rejectsZeroVaultSwap() public {
        vm.expectRevert("ArbitrageRouter: invalid vaultSwap");
        new ArbitrageRouter(signer, payer, address(token), address(0), keeper);
    }

    function test_rejectsZeroKeeper() public {
        vm.expectRevert("ArbitrageRouter: invalid onBehalfOf");
        new ArbitrageRouter(signer, payer, address(token), address(vaultSwap), address(0));
    }

    function test_signedPurchaseUsesOnlyTrustedAddresses() public {
        _relay(address(vaultSwap), keeper, "");
        assertEq(token.balanceOf(payer), 20);
        assertEq(token.balanceOf(address(vaultSwap)), 80);
        assertEq(vaultSwap.lastKeeper(), keeper);
        assertEq(token.allowance(address(router), address(vaultSwap)), 0);
    }

    function test_signedPurchaseRejectsUntrustedVaultSwap() public {
        RouterTestVaultSwap attacker = new RouterTestVaultSwap(token);
        _relay(address(attacker), keeper, "ArbitrageRouter: unauthorized vaultSwap");
        assertEq(token.balanceOf(payer), 100);
        assertEq(token.balanceOf(address(attacker)), 0);
        assertEq(token.allowance(payer, address(router)), 100);
    }

    function test_signedPurchaseRejectsUntrustedKeeper() public {
        _relay(address(vaultSwap), address(0xBAD), "ArbitrageRouter: unauthorized onBehalfOf");
        assertEq(token.balanceOf(payer), 100);
        assertEq(token.balanceOf(address(vaultSwap)), 0);
        assertEq(token.allowance(payer, address(router)), 100);
    }
}
