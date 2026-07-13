// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {IAllowanceTransfer} from "../../../lib/v4-periphery/lib/permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console} from "forge-std/console.sol";

contract MockUniswapV4DexAggRouter {
    address public immutable router;
    address public immutable permit2;

    constructor(address _router, address _permit2) {
        router = _router;
        permit2 = _permit2;
    }

    function approveThenCall(address tokenIn, uint256 amount, address tokenOut, bytes calldata data) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amount);
        IERC20(tokenIn).approve(permit2, amount);
        IAllowanceTransfer(permit2).approve(tokenIn, router, uint160(amount), type(uint48).max);

        (bool success, bytes memory err) = router.call(data);
        if (!success) {
            assembly {
                revert(add(err, 0x20), mload(err))
            }
        }
        IERC20(tokenOut).transfer(msg.sender, IERC20(tokenOut).balanceOf(address(this)));
    }
}
