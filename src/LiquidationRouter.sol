// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {AaveAdapter} from "vault-contracts/applications/aave/AaveAdapter.sol";
import {VenueManager} from "./VenueManager.sol";
import {Types} from "./lib/Types.sol";

contract LiquidationRouter is VenueManager {
    function _resumeAfterCallback(bytes memory data) internal virtual override {
        Types.LiquidationIteration memory iteration = abi.decode(data, (Types.LiquidationIteration));
        _iterateFlashLoan(iteration);
    }

    function _iterateFlashLoan(Types.LiquidationIteration memory iteration) internal virtual {}
}
