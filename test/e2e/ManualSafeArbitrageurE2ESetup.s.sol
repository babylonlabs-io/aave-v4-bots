// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {ArbitrageurE2ESetup} from "./ArbitrageurE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";
import {E2ESafe} from "./helpers/E2ESafe.sol";

/// @title ManualSafeArbitrageurE2ESetup
/// @notice E2E setup for the **MANUAL (Safe)** arbitrageur suite — the arb bot running **both
///         engines**, keyless, with a 1-of-1 Safe as the executor. The Safe holds the inventory
///         (WBTC + USDC) and is `msg.sender` of every action; the bot only proposes, and an
///         operator drives each proposal through `operator-cli`
///         (`test/e2e/scripts/operator-confirm.sh`).
/// @dev This suite is the reason `swapExitBtcForVaultOnBehalf` exists in the engine. Vault keepers are
///      registered *by BTC public key* against a roster frozen at vault creation, so a Safe — a
///      contract, with no BTC key — can never be a keeper and can never be `msg.sender` of the
///      direct `swapExitBtcForVault`. Splitting payer from beneficiary is the only way a multisig can
///      fund acquisitions: the Safe pays, and `VAULT_KEEPER_ADDRESS` (the registered ARBITRAGEUR /
///      APP_OPERATOR_0) receives the redeemed vault. That is also the realistic production shape —
///      a treasury multisig funding a permissioned keeper.
///
///      The Safe's owner is SAFE_OWNER — a **different** account from the ARBITRAGEUR keeper, so
///      custody and the redemption beneficiary are genuinely independent identities rather than one
///      address wearing two hats. The operator's external signing tool holds that owner key to
///      submit `execTransaction`; nothing in this suite ever holds the keeper's key.
///      Verify with ManualSafeArbitrageurE2EVerify (balances are the Safe's, not the EOA's).
contract ManualSafeArbitrageurE2ESetup is ArbitrageurE2ESetup {
    E2ESafe internal safe;

    address internal constant MULTI_SEND_CALL_ONLY = 0xA83c336B20401Af773B6219BA5027174338D1836;
    string internal constant MULTI_SEND_CALL_ONLY_CODE =
        "0x60806040526004361061001e5760003560e01c80638d80ff0a14610023575b600080fd5b6100dc6004803603602081101561003957600080fd5b810190808035906020019064010000000081111561005657600080fd5b82018360208201111561006857600080fd5b8035906020019184600183028401116401000000008311171561008a57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f8201169050808301925050505050505091929192905050506100de565b005b805160205b8181101561016a578083015160f81c6001820184015160601c3081150281179050601583018501516035840186015160558501870160008560008114610130576001811461014057610145565b6000808585888a5af19150610145565b600080fd5b5080610157576040513d6000823e3d81fd5b82605501870196505050505050506100e3565b50505056fea26469706673582212201ad552da02f0e66afd7f2ad29a305f1d4c737610d3b9e7ce8c994444949e57d664736f6c63430007060033";

    /// Deploy the Safe and fund IT (not the EOA) — it is the executor whose balances and
    /// allowances both engines read, which repays debt and which pays for acquisitions.
    function _setupExecutor(uint256 adminPrivateKey) internal override {
        vm.startBroadcast(adminPrivateKey);
        address[] memory owners = new address[](1);
        owners[0] = E2EConstants.SAFE_OWNER;
        safe = new E2ESafe(owners, 1);
        wbtc.mint(address(safe), 10 * uint256(ONE_BTC));
        usdc.mint(address(safe), 10_000 * ONE_USDC);
        vm.stopBroadcast();

        vm.writeFile(".e2e-safe-address", vm.toString(address(safe)));
        console.log("Safe (executor):", address(safe), "funded with 10 WBTC + 10,000 USDC");
        _installMultiSendCallOnly();
    }

    /// The bot batches each acquisition through Safe's MultiSendCallOnly v1.5.0 at its canonical
    /// address and refuses any other code there. Plain Anvil has no deployment, so place the
    /// canonical runtime code (keccak 0xcdbd…6663) with `anvil_setCode`, immediately, like
    /// `_provisionGas`.
    function _installMultiSendCallOnly() internal {
        string[] memory inputs = new string[](6);
        inputs[0] = "cast";
        inputs[1] = "rpc";
        inputs[2] = "anvil_setCode";
        inputs[3] = vm.toString(MULTI_SEND_CALL_ONLY);
        inputs[4] = MULTI_SEND_CALL_ONLY_CODE;
        inputs[5] = string.concat("--rpc-url=", E2EConstants.RPC_URL);
        vm.ffi(inputs);
        console.log("Installed MultiSendCallOnly v1.5.0 at", MULTI_SEND_CALL_ONLY);
    }

    /// Save the SAFE's balances (the payer) AND the keeper's (via `super`) — the verify asserts the
    /// Safe's WBTC fell while the keeper's did not, which is what proves payer and beneficiary are
    /// genuinely separate rather than one account funding itself.
    function _saveInitialBalances() internal override {
        super._saveInitialBalances();
        vm.writeFile(".e2e-initial-safe-wbtc", vm.toString(wbtc.balanceOf(address(safe))));
        vm.writeFile(".e2e-initial-safe-usdc", vm.toString(usdc.balanceOf(address(safe))));
    }

    /// @dev `VAULT_KEEPER_ADDRESS` is what routes the acquisition through
    ///      `swapExitBtcForVaultOnBehalf`: the Safe pays, ARBITRAGEUR (a registered keeper) receives.
    ///      Without it the swap would revert `UnauthorizedVaultKeeper()`.
    function _executionEnvLines() internal view override returns (string memory) {
        return string.concat(
            "EXECUTION_MODE=MANUAL\n",
            "MANUAL_EXECUTOR_KIND=safe\n",
            "MANUAL_EXECUTOR_ADDRESS=",
            vm.toString(address(safe)),
            "\n",
            "VAULT_KEEPER_ADDRESS=",
            vm.toString(E2EConstants.ARBITRAGEUR),
            "\n"
        );
    }
}
