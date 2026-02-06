import { createConfig } from "ponder";

import { btcVaultsManagerAbi } from "./abis/BTCVaultsManager";
import { vaultSwapAbi } from "./abis/VaultSwap";

// Validate required environment variables
const PONDER_RPC_URL = process.env.PONDER_RPC_URL;
const VAULT_SWAP_ADDRESS = process.env.VAULT_SWAP_ADDRESS;
const BTC_VAULTS_MANAGER_ADDRESS = process.env.BTC_VAULTS_MANAGER_ADDRESS;
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL = Number(process.env.PONDER_POLLING_INTERVAL || 1000);
const CHAIN_ID = Number(process.env.CHAIN_ID || 1);

if (!PONDER_RPC_URL) {
  throw new Error("PONDER_RPC_URL environment variable is required");
}

if (!VAULT_SWAP_ADDRESS) {
  throw new Error("VAULT_SWAP_ADDRESS environment variable is required");
}

if (!BTC_VAULTS_MANAGER_ADDRESS) {
  throw new Error("BTC_VAULTS_MANAGER_ADDRESS environment variable is required");
}

export default createConfig({
  chains: {
    local: {
      id: CHAIN_ID,
      rpc: PONDER_RPC_URL,
      pollingInterval: POLLING_INTERVAL,
    },
  },
  contracts: {
    VaultSwap: {
      abi: vaultSwapAbi,
      chain: {
        local: {
          address: VAULT_SWAP_ADDRESS as `0x${string}`,
          startBlock: START_BLOCK,
        },
      },
    },
    BTCVaultsManager: {
      abi: btcVaultsManagerAbi,
      chain: {
        local: {
          address: BTC_VAULTS_MANAGER_ADDRESS as `0x${string}`,
          startBlock: START_BLOCK,
        },
      },
    },
  },
  database: DATABASE_URL
    ? {
        kind: "postgres",
        connectionString: DATABASE_URL,
      }
    : undefined,
});
