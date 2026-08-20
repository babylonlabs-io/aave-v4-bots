// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {LiquidationRouter} from "../contracts/LiquidationRouter.sol";

/// @title DeployLiquidationRouter
/// @notice Deploys a {LiquidationRouter}, which repays a liquidation from flash-borrowed funds so
///         the bot's key never has to hold the debt tokens.
/// @dev Usage:
///
///        LIQUIDATION_ROUTER_OWNER=0x…  # the bot's key. The only address the router will act for
///        LENS_ADDRESS=0x…             # AaveAdapterLens; the router reads the adapter/spoke from it
///        VAULT_SWAP_ADDRESS=0x…       # the BTCVaultSwap (LLP) the seized vault is sold to
///        forge script scripts/DeployLiquidationRouter.s.sol:DeployLiquidationRouter \
///          --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
///
///      The router still needs its venues before it can fund anything — a `UniswapV4SwapVenue` (or
///      equivalent) per debt token, plus the WBTC flash-loan venue for the LLP fairness payment.
///      Those go in the bot's env as `FLASH_SWAP_POOLS` / `WBTC_FLASH_LOAN_ADDRESS`; see
///      `env.liquidator.example` and `docs/design-021-flash-funded-liquidations.md`.
contract DeployLiquidationRouter is Script {
    function run() external returns (LiquidationRouter router) {
        address owner = vm.envAddress("LIQUIDATION_ROUTER_OWNER");
        address lens = vm.envAddress("LENS_ADDRESS");
        address vaultSwap = vm.envAddress("VAULT_SWAP_ADDRESS");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        router = deploy(owner, lens, vaultSwap);
        vm.stopBroadcast();

        console.log("Set LIQUIDATION_FUNDING=flash and LIQUIDATION_ROUTER_ADDRESS in the bot's env.");
    }

    /// @notice Deploy without managing the broadcast, for callers already inside one.
    /// @dev The e2e setup uses this so the suite deploys through the same path an operator does,
    ///      rather than a copy that can drift from it.
    function deploy(address owner, address lens, address vaultSwap) public returns (LiquidationRouter router) {
        router = new LiquidationRouter(owner, lens, vaultSwap);
        console.log("LiquidationRouter:", address(router));
        console.log("  owner (the only address it acts for):", owner);
        console.log("  lens:                                ", lens);
        console.log("  vaultSwap:                           ", vaultSwap);
    }
}
