// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArbitrageurE2ESetup} from "./ArbitrageurE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title ManualArbitrageurE2ESetup
/// @notice E2E setup for the **MANUAL (EOA)** arbitrageur suite — the arb bot running **both
///         engines** while holding no key at all. This is the MANUAL scenario that matters most in
///         production: the arbitrageur is the bot that carries inventory (WBTC to acquire vaults,
///         USDC to repay debt), so it is the one worth making keyless.
/// @dev Identical to the AUTO arbitrageur setup except the bot boots with `EXECUTION_MODE=MANUAL`,
///      `MANUAL_EXECUTOR_KIND=eoa`, and NO `ARBITRAGEUR_PRIVATE_KEY`. It only *proposes* the
///      approvals, the liquidation and the vault acquisition into its `StateStore`; an operator
///      holding the key the bot lacks drives them through `operator-cli`
///      (`test/e2e/scripts/operator-confirm.sh`) between setup and verify.
///
///      The executor is `ARBITRAGEUR` itself, which is APP_OPERATOR_0 — a **registered vault
///      keeper**. That is what lets this suite use the direct `swapWbtcForVault`: the account that
///      broadcasts is the account the vault is redeemed to. (The `safe` suite cannot, and uses
///      `swapWbtcForVaultOnBehalf` instead — see ManualSafeArbitrageurE2ESetup.)
///
///      Verify with ArbitrageurE2EVerify: the funded account and the executor are the same address
///      here, so the AUTO assertions (position cleared, vault acquired) hold unchanged.
contract ManualArbitrageurE2ESetup is ArbitrageurE2ESetup {
    function _executionEnvLines() internal pure override returns (string memory) {
        return string.concat(
            "EXECUTION_MODE=MANUAL\n",
            "MANUAL_EXECUTOR_KIND=eoa\n",
            "MANUAL_EXECUTOR_ADDRESS=",
            vm.toString(E2EConstants.ARBITRAGEUR),
            "\n"
        );
    }
}
