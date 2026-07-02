import { adapterAbi, spokeAbi, vaultSwapAbi } from "@repo/abis";
import { createConfig } from "ponder";

import { INDEX_ARBITRAGE, INDEX_LIQUIDATION } from "./src/flags";

// Shared chain config
const PONDER_RPC_URL = process.env.PONDER_RPC_URL;
const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL = Number(process.env.PONDER_POLLING_INTERVAL || 4000);

// Per-mode addresses
const SPOKE_ADDRESS = process.env.SPOKE_ADDRESS;
const ADAPTER_ADDRESS = process.env.ADAPTER_ADDRESS;
const VAULT_SWAP_ADDRESS = process.env.VAULT_SWAP_ADDRESS;

if (!PONDER_RPC_URL) {
  throw new Error("PONDER_RPC_URL environment variable is required");
}

// The mode gating + its fail-fast guards (half-configured / no-mode enabled) live
// in resolveIndexingModes, which runs when `./src/flags` is imported above.

// One network for every contract; handlers reference contract names, not the
// network key, so unifying the previous `chain` / `local` keys is safe.
const liquidationContracts = INDEX_LIQUIDATION
  ? {
      Spoke: {
        abi: spokeAbi,
        chain: { chain: { address: SPOKE_ADDRESS as `0x${string}`, startBlock: START_BLOCK } },
      },
      Adapter: {
        abi: adapterAbi,
        chain: { chain: { address: ADAPTER_ADDRESS as `0x${string}`, startBlock: START_BLOCK } },
      },
    }
  : {};

const arbitrageContracts = INDEX_ARBITRAGE
  ? {
      VaultSwap: {
        abi: vaultSwapAbi,
        chain: {
          chain: { address: VAULT_SWAP_ADDRESS as `0x${string}`, startBlock: START_BLOCK },
        },
      },
    }
  : {};

export default createConfig({
  chains: {
    chain: {
      id: CHAIN_ID,
      rpc: PONDER_RPC_URL,
      pollingInterval: POLLING_INTERVAL,
    },
  },
  contracts: {
    ...liquidationContracts,
    ...arbitrageContracts,
  },
  database: DATABASE_URL
    ? {
        kind: "postgres",
        connectionString: DATABASE_URL,
      }
    : undefined,
});
