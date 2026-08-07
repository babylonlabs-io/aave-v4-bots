// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AaveAdapterLens} from "vault-contracts/applications/aave/AaveAdapterLens.sol";
import {BaseBot} from "./abstract/BaseBot.sol";

/// @title StressCohortCheck
/// @notice The stress suite's calibration guard, run by `stress-drive.sh` between price drops.
/// @dev Asserts the two cohorts are in the states the wave they just entered requires:
///      - `STRESS_PHASE=1` (after drop #1, −40%): cohort A liquidatable, cohort B **still healthy**.
///      - `STRESS_PHASE=2` (after drop #2, a further −35%): cohort B liquidatable.
///
///      This lives in forge rather than the bash driver on purpose. The check needs a position's
///      proxy, and `getPosition` returns a struct whose first member is a `bytes32[]` — decoding
///      that by hand in bash produced a false "not liquidatable" failure. Here it is just
///      `getPosition(x).proxyContract`, and `_isLiquidatable` is the same predicate every other
///      suite uses.
///
///      A silent mis-calibration is the specific hazard: if B flipped at drop #1 the two waves
///      would collapse into one and every later assertion would still pass, leaving a strictly
///      weaker test that looks identical to a healthy one.
contract StressCohortCheck is Script, BaseBot {
    function run() public {
        init(vm);

        uint256 phase = vm.envUint("STRESS_PHASE");
        AaveAdapterLens lens = AaveAdapterLens(vm.parseAddress(vm.readFile(".e2e-stress-lens")));

        address[] memory cohortA = _readAddresses(".e2e-stress-cohort-a");
        address[] memory cohortB = _readAddresses(".e2e-stress-cohort-b");

        if (phase == 1) {
            console.log("\n--- Cohort split after drop #1 ---");
            for (uint256 i = 0; i < cohortA.length; i++) {
                require(_liquidatable(lens, cohortA[i]), "cohort A not liquidatable after drop #1 (under-calibrated)");
            }
            console.log("[PASS] all %s cohort A positions liquidatable", cohortA.length);

            for (uint256 i = 0; i < cohortB.length; i++) {
                require(
                    !_liquidatable(lens, cohortB[i]), "cohort B liquidatable after drop #1 (waves collapsed into one)"
                );
            }
            console.log("[PASS] all %s cohort B positions still healthy", cohortB.length);
        } else if (phase == 2) {
            console.log("\n--- Cohort B after drop #2 ---");
            for (uint256 i = 0; i < cohortB.length; i++) {
                require(_liquidatable(lens, cohortB[i]), "cohort B not liquidatable after drop #2 (over-calibrated)");
            }
            console.log("[PASS] all %s cohort B positions liquidatable", cohortB.length);
        } else {
            // Anything else is a caller bug. Silently running phase 2's checks would report a pass
            // for a phase nobody asked about.
            revert("unknown STRESS_PHASE (expected 1 or 2)");
        }
    }

    /// @dev Liquidatable *right now*. A position the bot already cleared has no proxy debt left and
    ///      the Lens reverts on it, which reads the same as healthy — so this is only meaningful
    ///      before the bot has had a chance to act on the cohort.
    function _liquidatable(AaveAdapterLens lens, address borrower) internal view returns (bool) {
        address proxy = aaveAdapter.getPosition(borrower).proxyContract;
        if (proxy == address(0)) return false;
        try lens.estimateLiquidation(proxy, false) returns (uint256[] memory, uint256, bytes32[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _readAddresses(string memory file) internal view returns (address[] memory out) {
        string[] memory parts = vm.split(vm.readFile(file), ",");
        out = new address[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            out[i] = vm.parseAddress(parts[i]);
        }
    }
}
