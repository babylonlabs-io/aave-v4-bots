// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.0;

import {Types} from "./base/Types.sol";
import {TestSuites} from "./base/TestSuites.sol";
import {Test} from "forge-std/Test.sol";
import {
    ArbitrageRouterOldVaultSwap,
    SelfCallRelayer,
    IOldBTCVaultSwap
} from "../../src/ArbitrageRouterOldVaultSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BTCVaultSwap, IBTCVaultSwap} from "../../lib/contracts/src/applications/aave/llps/BTCVaultSwap.sol";

contract ArbitrageRouterTest is TestSuites, Test {
    address internal ADMIN = vm.addr(69420);
    address internal RANDOM_CALLER = vm.addr(69421);
    address internal FUND = vm.addr(42161);

    address public router;

    // ---------------------------------------------------------------------
    // EIP-712 encoding, written from the spec (eips.ethereum.org/EIPS/eip-712).
    //
    //   digest        = keccak256(0x19 ++ 0x01 ++ domainSeparator ++ hashStruct(message))
    //   hashStruct(s) = keccak256(typeHash ++ encodeData(s))
    //   typeHash      = keccak256(encodeType(s))
    //
    // encodeType: the primary type first, then every referenced struct type sorted
    // alphabetically by name, each as `Name(type1 field1,type2 field2)` with no spaces.
    // `RelayerMessage` references `Call`, so:
    //   "RelayerMessage(Call[] calls,uint256 deadline)Call(bytes data,uint256 value)"
    //
    // encodeData, per member:
    //   - atomic (uint256, address, bytes32, bool): 32-byte padded value, as abi.encode
    //   - dynamic (bytes, string):                  keccak256 of the *contents*
    //   - array:                                    keccak256 of the concatenated
    //                                               encodeData of its elements
    //   - struct:                                   its own hashStruct
    // ---------------------------------------------------------------------

    string internal constant EIP712_NAME = "ArbitrageRouter";
    string internal constant EIP712_VERSION = "1.0.0";

    string internal constant CALL_TYPE = "Call(bytes data,uint256 value)";
    string internal constant RELAYER_MESSAGE_TYPE =
        "RelayerMessage(Call[] calls,uint256 deadline)Call(bytes data,uint256 value)";

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(EIP712_VERSION)),
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @dev `bytes data` is a dynamic type, so encodeData hashes its contents.
    function _hashCall(SelfCallRelayer.Call memory call) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(CALL_TYPE)), keccak256(call.data), call.value));
    }

    /// @dev `Call[] calls` is an array of structs: keccak256 of the concatenated member hashes.
    function _hashRelayerMessage(SelfCallRelayer.RelayerMessage memory message) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](message.calls.length);
        for (uint256 i = 0; i < message.calls.length; i++) {
            callHashes[i] = _hashCall(message.calls[i]);
        }

        return keccak256(
            abi.encode(
                keccak256(bytes(RELAYER_MESSAGE_TYPE)), keccak256(abi.encodePacked(callHashes)), message.deadline
            )
        );
    }

    function _digest(address verifyingContract, SelfCallRelayer.RelayerMessage memory message)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1901", _domainSeparator(verifyingContract), _hashRelayerMessage(message)));
    }

    // ---------------------------------------------------------------------

    function setUp() public {}

    function _setUpPerTest() internal {
        vm.deal(ADMIN, 100 ether);
        router = address(new ArbitrageRouterOldVaultSwap(ADMIN, FUND, WBTC));

        deal(WBTC, FUND, 2 ** 96);

        vm.prank(FUND);
        IERC20(WBTC).approve(router, type(uint256).max);

        vm.deal(RANDOM_CALLER, 100 ether);
    }

    function test_ARBITRAGE_TEST0() external {
        Types.ArbitrageTestParams memory params = ARBITRAGE_TESTS[0];
        vm.createSelectFork(vm.rpcUrl(params.arbitrage.network), params.arbitrage.blockNumber);
        _setUpPerTest();

        SelfCallRelayer.Call[] memory calls = new SelfCallRelayer.Call[](params.arbitrage.vaultIds.length);
        for (uint256 i = 0; i < calls.length; i++) {
            calls[i].data = abi.encodeWithSelector(
                ArbitrageRouterOldVaultSwap.swapWbtcToVault.selector,
                params.tbvContracts.btcVaultSwap,
                params.arbitrage.vaultIds[i],
                TESTNET_VK,
                0
            );

            vm.assertTrue(
                IOldBTCVaultSwap(params.tbvContracts.btcVaultSwap).isVaultEscrowed(params.arbitrage.vaultIds[i]),
                "Vault status is not active"
            );
        }

        SelfCallRelayer.RelayerMessage memory message =
            SelfCallRelayer.RelayerMessage({calls: calls, deadline: type(uint256).max});

        bytes32 digest = _digest(router, message);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(69420, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(RANDOM_CALLER);
        ArbitrageRouterOldVaultSwap(router).relay(message, signature);
    }
}
