import { createConfig } from "ponder";

import { controllerAbi } from "./abis/Controller";
import { spokeAbi } from "./abis/Spoke";

// Validate required environment variables
const PONDER_RPC_URL = process.env.PONDER_RPC_URL;
const SPOKE_ADDRESS = process.env.SPOKE_ADDRESS;
const CONTROLLER_ADDRESS = process.env.CONTROLLER_ADDRESS;
const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL = Number(process.env.PONDER_POLLING_INTERVAL || 1000);

if (!PONDER_RPC_URL) {
  throw new Error("PONDER_RPC_URL environment variable is required");
}

if (!SPOKE_ADDRESS) {
  throw new Error("SPOKE_ADDRESS environment variable is required");
}

if (!CONTROLLER_ADDRESS) {
  throw new Error("CONTROLLER_ADDRESS environment variable is required");
}

export default createConfig({
  chains: {
    chain: {
      id: CHAIN_ID,
      rpc: PONDER_RPC_URL,
      pollingInterval: POLLING_INTERVAL,
    },
  },
  contracts: {
    Spoke: {
      abi: spokeAbi,
      chain: {
        chain: {
          address: SPOKE_ADDRESS as `0x${string}`,
          startBlock: START_BLOCK,
        },
      },
    },
    Controller: {
      abi: controllerAbi,
      chain: {
        chain: {
          address: CONTROLLER_ADDRESS as `0x${string}`,
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
