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

    address internal constant WBTC = address(0x504579d0424B7B7cB4b17e16626f6A2f67bCa054);

    address internal constant TESTNET_VK = address(0x9814d7f1B125bDB4fcEd6234439dD73fa14473a6);

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

    Types.LiquidationTestParams[] internal LIQUIDATION_TESTS = [
        Types.LiquidationTestParams({
            tbvContracts: TBV_CONTRACTS_TESTNET,
            liquidation: Types.Liquidation({
                network: "sepolia",
                blockNumber: 11141103,
                borrower: address(0x4D1Ef18305EAe34Eaf3A7c227715A42813d667dA),
                hasFairnessPayment: false
            })
        }),
        Types.LiquidationTestParams({
            tbvContracts: TBV_CONTRACTS_TESTNET,
            liquidation: Types.Liquidation({
                network: "sepolia",
                blockNumber: 11130814,
                borrower: address(0x0F586D04909546079FecddFB09d0Bb3d50871261),
                hasFairnessPayment: true
            })
        })
    ];

    Types.ArbitrageTestParams[] internal ARBITRAGE_TESTS = [Types.ArbitrageTestParams({
            tbvContracts: TBV_CONTRACTS_TESTNET,
            arbitrage: Types.Arbitrage({
                network: "sepolia",
                blockNumber: 11130572,
                vaultIds: _packBytes32(
                    bytes32(0xa3294989d32183ed173cae7c4d3f8ead982133350a44160dc593d0640b6c64eb),
                    bytes32(0x7ad0bd5d0344bd467f9d58f7107ab96fd079ac930f761a083f444ccd4099347a)
                )
            })
        })];

    function _packBytes32(bytes32 a) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](1);
        arr[0] = a;
    }

    function _packBytes32(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
