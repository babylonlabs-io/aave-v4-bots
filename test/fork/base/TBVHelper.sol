// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAaveOracle} from "../../../lib/contracts/lib/aave-v4/src/spoke/interfaces/IAaveOracle.sol";
import {AaveAdapter} from "../../../lib/contracts/src/applications/aave/AaveAdapter.sol";
import {IAaveSpoke} from "../../../lib/contracts/src/applications/aave/interfaces/IAaveSpoke.sol";

abstract contract TBVHelper {
    function _getWbtcPriceAgainstTokens(address adapter, address[] memory tokens)
        internal
        view
        returns (uint256[] memory)
    {
        address spoke = address(AaveAdapter(adapter).BTC_VAULT_CORE_SPOKE());
        address oracle = IAaveSpoke(spoke).ORACLE();

        uint256 cnt = IAaveSpoke(spoke).getReserveCount();
        IAaveSpoke.Reserve[] memory reserves = new IAaveSpoke.Reserve[](cnt);
        for (uint256 i = 0; i < cnt; i++) {
            reserves[i] = IAaveSpoke(spoke).getReserve(i);
        }

        uint256 wbtcPrice = IAaveOracle(oracle).getReservePrice(AaveAdapter(adapter).WBTC_RESERVE_ID());

        uint256[] memory prices = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            for (uint256 j = 0; j < cnt; j++) {
                if (reserves[j].underlying == tokens[i]) {
                    uint256 tokenPrice = IAaveOracle(oracle).getReservePrice(j);
                    prices[i] = wbtcPrice * 1e8 / tokenPrice;
                    break;
                }
            }
        }
        return prices;
    }

    function _eliminateSelector(bytes memory data) internal pure returns (bytes memory truncated) {
        truncated = new bytes(data.length - 4);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = data[i + 4];
        }
    }
}
