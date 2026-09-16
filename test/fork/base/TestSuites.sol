// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Types} from "./Types.sol";

abstract contract TestSuites {
    /// @notice The Ethereum mainnet block every fork suite forks at.
    /// @dev One block for all of them, so foundry serves every suite from a single `~/.foundry/cache/rpc` entry.
    ///      The liquidation suites deploy the TBV protocol and their own pools, so they take only the venue
    ///      bytecode below from the fork. `VenueQuoteParityTest` and the TypeScript venue-ranking fork test also
    ///      read two real hookless WBTC/USDC pools, which price a 50,000 USDC borrow apart at this block.
    ///      The e2e liquidator suite forks the same block (`scripts/e2e-local.sh`).
    uint256 internal constant MAINNET_FORK_BLOCK = 25982687;

    address internal constant UNISWAP_V4_POOL_MANAGER = address(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address internal constant UNISWAP_V4_ROUTER = address(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    address internal constant UNISWAP_V4_PERMIT2 = address(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant UNISWAP_V4_POSITION_MANAGER = address(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address internal constant UNISWAP_V4_QUOTER = address(0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203);

    address internal constant MORPHO_BLUE = address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);

    address internal constant MAINNET_WBTC = address(0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599);
    address internal constant MAINNET_USDC = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

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
            network: "mainnet",
            blockNumber: MAINNET_FORK_BLOCK,
            collateralValueUsd: 80_000,
            borrowValueUsd: 60_000,
            dropPercent: 30,
            hasFairnessPayment: false
        }),
        Types.LiquidationScenario({
            network: "mainnet",
            blockNumber: MAINNET_FORK_BLOCK,
            collateralValueUsd: 100_000,
            borrowValueUsd: 40_000,
            dropPercent: 53,
            hasFairnessPayment: true
        })
    ];
}
