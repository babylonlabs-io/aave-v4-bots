// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

/// @title E2EConstants
/// @notice Constants used across E2E test scripts
library E2EConstants {
    // Anvil test accounts (from mnemonic: "test test test test test test test test test test test junk")
    address internal constant ADMIN = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant ADMIN_PRIVATE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Liquidator (Anvil account[1])
    address internal constant LIQUIDATOR = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 internal constant LIQUIDATOR_PRIVATE_KEY =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    // Arbitrageur (Anvil account[2])
    address internal constant ARBITRAGEUR = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    uint256 internal constant ARBITRAGEUR_PRIVATE_KEY =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    // Borrower (Anvil account[11])
    uint256 internal constant BORROWER_PRIVATE_KEY = 12;

    // Postgres database configuration (using same instance with different schemas)
    string internal constant DB_URL = "postgresql://ponder:ponder@localhost:5432/ponder";
    string internal constant LIQUIDATOR_DB_SCHEMA = "liquidator";
    string internal constant ARBITRAGEUR_DB_SCHEMA = "arbitrageur";

    // Ponder service URLs and ports
    string internal constant LIQUIDATOR_PONDER_URL = "http://localhost:42069";
    string internal constant ARBITRAGEUR_PONDER_URL = "http://localhost:42070";
    uint256 internal constant LIQUIDATOR_PONDER_PORT = 42069;
    uint256 internal constant ARBITRAGEUR_PONDER_PORT = 42070;

    // RPC URL for local Anvil
    string internal constant RPC_URL = "http://localhost:8545";

    // Chain ID for local Anvil
    uint256 internal constant CHAIN_ID = 31337;
}
