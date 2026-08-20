import { adapterAbi, spokeAbi, vaultSwapAbi } from "@repo/abis";
import { createAwsSecrets } from "@repo/secrets";
import { createConfig } from "ponder";

import { INDEX_ARBITRAGE, INDEX_LIQUIDATION } from "./src/flags";

// Secret-bearing values (DB connection, RPC URL) are read from env first; if one is absent
// and CONFIG_SECRET_ID is set, it falls back to that AWS Secrets Manager JSON secret's
// matching field (e.g. `<CONFIG_SECRET_ID>#DATABASE_URL`). Unset ⇒ pure env (unchanged).
const CONFIG_SECRET_ID = process.env.CONFIG_SECRET_ID;
const secrets = CONFIG_SECRET_ID ? createAwsSecrets({ region: process.env.AWS_REGION }) : undefined;

async function resolveSecret(name: string): Promise<string | undefined> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (secrets && CONFIG_SECRET_ID)
    return secrets.get(`${CONFIG_SECRET_ID}#${name}`, "CONFIG_SECRET_ID");
  return undefined;
}

// Shared chain config
const PONDER_RPC_URL = await resolveSecret("PONDER_RPC_URL");
const DATABASE_URL = await resolveSecret("DATABASE_URL");
const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const START_BLOCK = Number(process.env.START_BLOCK || 0);
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
