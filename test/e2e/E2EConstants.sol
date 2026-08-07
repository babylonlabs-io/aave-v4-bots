// SPDX-License-Identifier: MIT
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

    // Arbitrageur (derived from private key 0x1) — this is APP_OPERATOR_0, a
    // registered vault keeper. The acquisition leg (swapWbtcForVault) redeems to
    // the caller's registered BTC key, so the arbitrageur MUST be a keeper; a
    // plain funded account would revert with UnauthorizedVaultKeeper().
    address internal constant ARBITRAGEUR = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    uint256 internal constant ARBITRAGEUR_PRIVATE_KEY =
        0x0000000000000000000000000000000000000000000000000000000000000001;

    // Safe owner for the MANUAL `safe` suite (Anvil account[2]) — the human operator who signs
    // SafeTxs and submits `execTransaction`. Deliberately NOT the vault keeper: the Safe pays and
    // the keeper receives, so keeping custody and the redemption beneficiary on separate accounts
    // is what proves the payer/beneficiary split is real rather than an alias for one identity.
    // Genesis-funded by Anvil, so it has ETH for gas without being provisioned.
    address internal constant SAFE_OWNER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    uint256 internal constant SAFE_OWNER_PRIVATE_KEY =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    // Borrower (Anvil account[11])
    uint256 internal constant BORROWER_PRIVATE_KEY = 12;

    // Router funding. Deliberately accounts no bot holds a key for — the point of the mode is that
    // the float and the signing key live apart, which an alias of an existing role would not show.
    //
    // The treasury supplies the WBTC and approves the ArbitrageRouter. A key well clear of the
    // stress suite's borrowers, which run from 20 upward.
    uint256 internal constant TREASURY_PRIVATE_KEY = 1000;
    /// Plays both antagonists in the stress suite's router mode: it submits a copy of OUR signed
    /// batch (paying only gas — the treasury still pays), and separately buys a vault with its own
    /// WBTC. Neither proves anything unless it is an account the bot depends on for nothing.
    uint256 internal constant FRONTRUNNER_PRIVATE_KEY = 1001;

    // Postgres database configuration (separate databases to avoid Ponder sync conflicts)
    string internal constant LIQUIDATOR_DB_URL = "postgresql://ponder:ponder@localhost:5432/ponder_liquidator";
    string internal constant ARBITRAGEUR_DB_URL = "postgresql://ponder:ponder@localhost:5432/ponder_arbitrageur";

    // Ponder service URLs and ports
    string internal constant LIQUIDATOR_PONDER_URL = "http://localhost:42069";
    string internal constant ARBITRAGEUR_PONDER_URL = "http://localhost:42070";
    uint256 internal constant LIQUIDATOR_PONDER_PORT = 42069;
    uint256 internal constant ARBITRAGEUR_PONDER_PORT = 42070;

    // Metrics servers (Prometheus scrape target: /metrics, /health, /ready — never the kill switch)
    uint256 internal constant LIQUIDATOR_METRICS_PORT = 9090;
    uint256 internal constant ARBITRAGEUR_METRICS_PORT = 9091;

    // Kill-switch control servers. A SEPARATE socket from the metrics port, bound to loopback:
    // an endpoint that can stop trading must not share an exposure decision with a scrape target.
    uint256 internal constant LIQUIDATOR_CONTROL_PORT = 9095;
    uint256 internal constant ARBITRAGEUR_CONTROL_PORT = 9096;
    /// @dev E2E-only. Real deployments resolve this through the `repo/secrets` package; the env var here is
    ///      the `env` provider's backing store, which is what `RISK_CONTROL_TOKEN_REF` names.
    string internal constant CONTROL_TOKEN = "e2e-kill-switch-token";
    string internal constant CONTROL_TOKEN_REF = "BOT_CONTROL_TOKEN";

    // RPC URL for local Anvil
    string internal constant RPC_URL = "http://localhost:8545";

    // Chain ID for local Anvil
    /// @dev Bare anvil. Scripts that write a bot's env should use `block.chainid` instead — under
    ///      `E2E_FORK_URL` the suite runs on a fork and keeps the forked chain's id, so a hardcoded
    ///      31337 would have the bot signing for the wrong chain.
    uint256 internal constant CHAIN_ID = 31337;
}
