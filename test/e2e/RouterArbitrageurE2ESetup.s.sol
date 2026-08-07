// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {ArbitrageRouter} from "../../contracts/ArbitrageRouter.sol";
import {DeployArbitrageRouter} from "../../scripts/DeployArbitrageRouter.s.sol";
import {ArbitrageurE2ESetup} from "./ArbitrageurE2ESetup.s.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title RouterArbitrageurE2ESetup
/// @notice E2E setup for **router-funded** vault acquisition: a treasury supplies the WBTC and the
///         bot's key only authorizes and submits.
/// @dev Same bot and both engines as `ArbitrageurE2ESetup`, with the acquisition leg re-pointed at
///      an {ArbitrageRouter}. What this suite proves that the others cannot is the split itself —
///      the treasury's WBTC falls while the bot's does not, so the acquisition demonstrably did not
///      come out of the signing key's balance.
///
///      The liquidation engine still runs inventory-funded off the bot's own tokens, which is why
///      the bot keeps its USDC and WBTC. Only the acquisition changes hands.
contract RouterArbitrageurE2ESetup is ArbitrageurE2ESetup {
    ArbitrageRouter internal router;

    /// The treasury. An account the bot holds no key for: the whole point is that the funds and
    /// the signing key live apart.
    uint256 internal constant TREASURY_PRIVATE_KEY = E2EConstants.TREASURY_PRIVATE_KEY;

    /// Deploy the router, fund the treasury, and have the treasury approve it — the one step the
    /// bot cannot do for itself, and the one `prepare()` refuses to start without.
    function _setupExecutor(uint256 adminPrivateKey) internal override {
        vm.startBroadcast(adminPrivateKey);
        // Through the operator's own deploy script, so a break in the documented deployment path
        // fails this suite rather than being discovered in production.
        address treasury = vm.addr(TREASURY_PRIVATE_KEY);
        router = new DeployArbitrageRouter().deploy(arbAddr, treasury, address(wbtc));
        wbtc.mint(treasury, 10 * uint256(ONE_BTC));
        vm.stopBroadcast();

        // The approval comes from the TREASURY's own key, as it must: only the payer can grant it.
        vm.startBroadcast(TREASURY_PRIVATE_KEY);
        wbtc.approve(address(router), 10 * uint256(ONE_BTC));
        vm.stopBroadcast();

        _provisionGas(treasury, 1 ether);
        console.log("Treasury (payer):", treasury, "funded with 10 WBTC and approved to the router");
    }

    /// Record the treasury's WBTC too — the verification's whole claim is a comparison between it
    /// and the bot's.
    function _saveInitialBalances() internal override {
        super._saveInitialBalances();
        vm.writeFile(".e2e-initial-treasury-wbtc", vm.toString(wbtc.balanceOf(vm.addr(TREASURY_PRIVATE_KEY))));
    }

    /// @dev `VAULT_KEEPER_ADDRESS` is mandatory here: the router only ever calls
    ///      `swapWbtcForVaultOnBehalf`. The bot is itself the registered keeper, so it receives the
    ///      vault while the treasury pays for it.
    function _executionEnvLines() internal view override returns (string memory) {
        return string.concat(
            super._executionEnvLines(),
            "ARBITRAGE_FUNDING=router\n",
            "ARBITRAGE_ROUTER_ADDRESS=",
            vm.toString(address(router)),
            "\n",
            "VAULT_KEEPER_ADDRESS=",
            vm.toString(arbAddr),
            "\n"
        );
    }
}
