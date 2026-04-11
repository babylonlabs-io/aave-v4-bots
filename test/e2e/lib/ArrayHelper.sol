// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

library ArrayHelper {
    function create(string memory s) internal pure returns (string[] memory arr) {
        arr = new string[](1);
        arr[0] = s;
    }

    function create(string memory s1, string memory s2) internal pure returns (string[] memory arr) {
        arr = new string[](2);
        arr[0] = s1;
        arr[1] = s2;
    }
}
