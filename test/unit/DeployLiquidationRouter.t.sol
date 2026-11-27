// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployLiquidationRouter} from "../../scripts/DeployLiquidationRouter.s.sol";
import {LiquidationRouter} from "../../contracts/LiquidationRouter.sol";
import {LensStub, VaultSwapStub} from "./LiquidationRouter.t.sol";

contract DeployLiquidationRouterTest is Test {
    function test_runReadsOwnerAndExecutorFromEnvironment() public {
        address owner = address(0xA11CE);
        address executor = address(0xB0B);
        LensStub lens = new LensStub(address(0xADA), address(0x5B0));
        VaultSwapStub vaultSwap = new VaultSwapStub(address(0xB7C));
        vm.setEnv("LIQUIDATION_ROUTER_OWNER", vm.toString(owner));
        vm.setEnv("LIQUIDATION_ROUTER_EXCUTOR", vm.toString(executor));
        vm.setEnv("LENS_ADDRESS", vm.toString(address(lens)));
        vm.setEnv("VAULT_SWAP_ADDRESS", vm.toString(address(vaultSwap)));

        LiquidationRouter router = new DeployLiquidationRouter().run();

        assertEq(router.owner(), owner);
        assertEq(router.executor(), executor);
        assertEq(router.lens(), address(lens));
        assertEq(router.btcVaultSwap(), address(vaultSwap));
    }
}
