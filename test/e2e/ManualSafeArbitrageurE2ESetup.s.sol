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
/// @dev This suite is the reason `swapWbtcForVaultOnBehalf` exists in the engine. Vault keepers are
///      registered *by BTC public key* against a roster frozen at vault creation, so a Safe — a
///      contract, with no BTC key — can never be a keeper and can never be `msg.sender` of the
///      direct `swapWbtcForVault`. Splitting payer from beneficiary is the only way a multisig can
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
    ///      `swapWbtcForVaultOnBehalf`: the Safe pays, ARBITRAGEUR (a registered keeper) receives.
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
