import { createConfig } from "ponder";

import { spokeAbi } from "./abis/Spoke";

// Validate required environment variables
const PONDER_RPC_URL = process.env.PONDER_RPC_URL_1;
const SPOKE_ADDRESS = process.env.SPOKE_ADDRESS;
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL = Number(process.env.PONDER_POLLING_INTERVAL || 1000);

if (!PONDER_RPC_URL) {
  throw new Error("PONDER_RPC_URL_1 environment variable is required");
}

if (!SPOKE_ADDRESS) {
  throw new Error("SPOKE_ADDRESS environment variable is required");
}

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: PONDER_RPC_URL,
      pollingInterval: POLLING_INTERVAL,
    },
  },
  contracts: {
    Spoke: {
      abi: spokeAbi,
      chain: {
        mainnet: {
          address: SPOKE_ADDRESS as `0x${string}`,
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
