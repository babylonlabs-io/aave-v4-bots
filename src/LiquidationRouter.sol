// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {AaveAdapter} from "vault-contracts/applications/aave/AaveAdapter.sol";
import {VenueManager} from "./VenueManager.sol";

contract LiquidationRouter is VenueManager {

    
    function _resumeAfterCallback(bytes memory data) internal virtual override {}
}
