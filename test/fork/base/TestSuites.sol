// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Types} from "./Types.sol";

abstract contract TestSuites {
    address internal constant UNISWAP_V4_POOL_MANAGER = address(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    address internal constant UNISWAP_V4_ROUTER = address(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    address internal constant UNISWAP_V4_PERMIT2 = address(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant UNISWAP_V4_POSITION_MANAGER = address(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
    address internal constant UNISWAP_V4_QUOTER = address(0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227);

    address internal constant MORPHO_BLUE = address(0xd011EE229E7459ba1ddd22631eF7bF528d424A14);

    /// @notice The block every scenario forks at.
    /// @dev One block for all of them, and deliberately one that was already pinned before the TBV
    ///      protocol moved into the fixture: the only thing the fork still has to provide is the
    ///      venue bytecode above, which does not change between these heights. Sharing it means
    ///      foundry serves every suite from a single `~/.foundry/cache/rpc` entry.
    uint256 internal constant SEPOLIA_FORK_BLOCK = 11141103;

    /// @dev The positions the liquidation suites build. Both borrow evenly across USDC and USDT, so
    ///      each exercises two flash venues, and between them they cover the fairness payment in both
    ///      directions — which is what decides whether the WBTC venue is drawn on at all.
    ///
    ///      The ratios are what separate them. `80 / 60` is borrowed near the 80% collateral factor,
    ///      so once the price falls far enough to make it liquidatable the debt consumes essentially
    ///      the whole vault and nothing is left over. `100 / 40` is borrowed well inside the factor
    ///      and pushed only just past the threshold, so seizing the whole (indivisible) vault takes
    ///      far more value than the debt needs and the excess comes back as a fairness payment.
    ///
    ///      That second drop sits inside a band with an edge on either side, which is why it is 53
    ///      and not a round number. Below 50% the position is still healthy and nothing can liquidate
    ///      it; above ~56% the debt plus the 10% liquidation bonus consumes the whole vault and the
    ///      excess — and with it the fairness payment, and with it the only draw on the WBTC flash
    ///      venue — disappears. `TESTALL` asserts the payment in both directions, so a scenario that
    ///      drifted out of the band fails loudly rather than silently testing one venue less.
    Types.LiquidationScenario[] internal LIQUIDATION_SCENARIOS = [
        Types.LiquidationScenario({
            network: "sepolia",
            blockNumber: SEPOLIA_FORK_BLOCK,
            collateralValueUsd: 80_000,
            borrowValueUsd: 60_000,
            dropPercent: 30,
            hasFairnessPayment: false
        }),
        Types.LiquidationScenario({
            network: "sepolia",
            blockNumber: SEPOLIA_FORK_BLOCK,
            collateralValueUsd: 100_000,
            borrowValueUsd: 40_000,
            dropPercent: 53,
            hasFairnessPayment: true
        })
    ];
}
