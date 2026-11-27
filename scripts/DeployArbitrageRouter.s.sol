// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ArbitrageRouter} from "../contracts/ArbitrageRouter.sol";

/// @title DeployArbitrageRouter
/// @notice Deploys an {ArbitrageRouter}, which lets a treasury fund vault acquisitions that a
///         separate hot key authorizes.
/// @dev Usage:
///
///        ARBITRAGE_ROUTER_SIGNER=0x…  # the bot's key. Authorizes acquisitions; holds no funds
///        ARBITRAGE_ROUTER_PAYER=0x…   # the treasury. Supplies the WBTC
///        WBTC_ADDRESS=0x…             # must match the LLP's EXIT_BTC()
///        VAULT_SWAP_ADDRESS=0x…       # trusted LLP
///        VAULT_KEEPER_ADDRESS=0x…     # trusted vault keeper
///        forge script scripts/DeployArbitrageRouter.s.sol:DeployArbitrageRouter \
///          --rpc-url "$RPC_URL" --account "$DEPLOYER" --sender "$DEPLOYER_ADDRESS" --broadcast
///
///      **The deploy is not the whole setup.** All constructor arguments are immutable, and
///      the router can move nothing until `payer` approves it:
///
///        cast send $WBTC_ADDRESS "approve(address,uint256)" $ROUTER $AMOUNT \
///          --rpc-url "$RPC_URL" --private-key "$PAYER_KEY"
///
///      Approve working capital rather than an unlimited amount. A compromised signer can still
///      execute purchases through the trusted LLP, so revoke approval if the signer is lost.
///      Rotation is impossible: changing any configured address means a new router.
contract DeployArbitrageRouter is Script {
    function run() external returns (ArbitrageRouter router) {
        address signer = vm.envAddress("ARBITRAGE_ROUTER_SIGNER");
        address payer = vm.envAddress("ARBITRAGE_ROUTER_PAYER");
        address wbtc = vm.envAddress("WBTC_ADDRESS");
        address vaultSwap = vm.envAddress("VAULT_SWAP_ADDRESS");
        address vaultKeeper = vm.envAddress("VAULT_KEEPER_ADDRESS");
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");

        vm.startBroadcast();
        router = deploy(signer, payer, wbtc, vaultSwap, vaultKeeper);
        vm.stopBroadcast();

        console.log("Set ARBITRAGE_FUNDING=router and ARBITRAGE_ROUTER_ADDRESS in the bot's env.");
        console.log("Then have the payer approve the router for its WBTC - see this script's docs.");
    }

    /// @notice Deploy without managing the broadcast, for callers already inside one.
    /// @dev The e2e setup uses this so the suite deploys through the same path an operator does,
    ///      rather than a copy that can drift from it.
    function deploy(address signer, address payer, address wbtc, address vaultSwap, address vaultKeeper)
        public
        returns (ArbitrageRouter router)
    {
        router = new ArbitrageRouter(signer, payer, wbtc, vaultSwap, vaultKeeper);
        console.log("ArbitrageRouter:", address(router));
        console.log("  signer (authorizes, holds nothing):", signer);
        console.log("  payer  (supplies the WBTC):        ", payer);
        console.log("  wbtc:                              ", wbtc);
        console.log("  vaultSwap:                         ", vaultSwap);
        console.log("  vault keeper:                      ", vaultKeeper);
    }
}
