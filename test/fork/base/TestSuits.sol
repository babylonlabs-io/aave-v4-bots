// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity 0.8.28;

import {Types} from "./types.sol";

abstract contract TestSuits {
    address internal constant UNISWAP_V4_POOL_MANAGER = address(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    address internal constant UNISWAP_V4_ROUTER = address(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    address internal constant UNISWAP_V4_PERMIT2 = address(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant UNISWAP_V4_POSITION_MANAGER = address(0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4);
    address internal constant UNISWAP_V4_QUOTER = address(0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227);

    address internal constant MORPHO_BLUE = address(0xd011EE229E7459ba1ddd22631eF7bF528d424A14);

    address[] internal DEBT_TOKENS_TESTNET = [
        address(0xB588C1bd8A6cd3F114A52a0AD916778B419ECf48), // USDC
        address(0xCFf21358114814258635524588f74521762A6c04) // USDT
    ];

    Types.TBVContracts internal TBV_CONTRACTS_TESTNET = Types.TBVContracts({
        btcVaultSwap: address(0xCaf3DE0ec631e2DEB3b4A33679037488B545f5a2),
        aaveAdapter: address(0xb08dfb1D04373a30A33CA64Ae85061e452E5CeF7),
        lens: address(0xF76c3E3A7c94E73497fdA00CbcDE56dbdcdDD8da),
        debtTokens: DEBT_TOKENS_TESTNET
    });

    Types.TestParams internal LIQUIDATION_TEST0 = Types.TestParams({
        tbvContracts: TBV_CONTRACTS_TESTNET,
        liquidation: Types.Liquidation({
            network: "sepolia", blockNumber: 11141103, borrower: address(0x4D1Ef18305EAe34Eaf3A7c227715A42813d667dA)
        })
    });
}
