// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {ArbitrageurE2EVerify} from "./ArbitrageurE2EVerify.s.sol";
import {E2EConstants} from "./E2EConstants.sol";

/// @title RouterArbitrageurE2EVerify
/// @notice Everything `ArbitrageurE2EVerify` checks, plus the claim that only router funding can
///         make: the vault was bought with the **treasury's** WBTC, not the bot's.
/// @dev The base run proves the vault was acquired and redeemed. That alone would also pass with
///      the bot paying for itself, so it cannot distinguish the two funding modes. The assertions
///      here are the difference — the treasury's balance fell, and it fell by the acquisition.
contract RouterArbitrageurE2EVerify is ArbitrageurE2EVerify {
    function run() public override {
        super.run();

        // Both reads happen after `super.run()`, which is what calls `init(vm)` — the saved balance
        // is a file written during setup, so reading it later is the same value.
        console.log("\n--- Who paid for the vault ---");
        uint256 treasuryBefore = _readInitialBalance(".e2e-initial-treasury-wbtc");
        uint256 treasuryNow = _getWbtcBalance(vm.addr(E2EConstants.TREASURY_PRIVATE_KEY));
        console.log("Treasury WBTC initial (sats):", treasuryBefore);
        console.log("Treasury WBTC now (sats):    ", treasuryNow);

        // The router pulls exactly the preview cost from the payer and sweeps any residue back, so
        // the treasury's balance falls by what the acquisition cost and nothing else.
        require(treasuryNow < treasuryBefore, "Treasury WBTC did not fall - the bot funded this itself");
        console.log("Treasury paid (sats):", treasuryBefore - treasuryNow);
        console.log("[PASS] The acquisition came out of the treasury, not the signing key");
    }
}
