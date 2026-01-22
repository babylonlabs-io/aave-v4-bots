import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load .env from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env") });

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { LiquidationBot } from "./bot";
import type { Config } from "./types";

function loadConfig(): Config {
  const requiredEnvVars = [
    "LIQUIDATOR_PRIVATE_KEY",
    "PONDER_URL",
    "RPC_URL",
    "CONTROLLER_ADDRESS",
    "VAULT_SWAP_ADDRESS",
    "DEBT_TOKEN_ADDRESS",
    "WBTC_ADDRESS",
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    liquidatorPrivateKey: process.env.LIQUIDATOR_PRIVATE_KEY as Hex,
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || "10000", 10),
    ponderUrl: process.env.PONDER_URL!,
    rpcUrl: process.env.RPC_URL!,
    controllerAddress: process.env.CONTROLLER_ADDRESS as Address,
    vaultSwapAddress: process.env.VAULT_SWAP_ADDRESS as Address,
    debtTokenAddress: process.env.DEBT_TOKEN_ADDRESS as Address,
    wbtcAddress: process.env.WBTC_ADDRESS as Address,
  };
}

async function main() {
  console.log("Aave V4 Liquidation Bot Starting...");

  const config = loadConfig();

  const account = privateKeyToAccount(config.liquidatorPrivateKey);
  console.log(`Liquidator address: ${account.address}`);

  // Create custom chain - auto-detect chainId from RPC
  const tempClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const chainId = await tempClient.getChainId();
  console.log(`Chain ID: ${chainId}`);

  const chain: Chain = {
    id: chainId,
    name: "Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [config.rpcUrl] },
    },
  };

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const walletClient = createWalletClient({
    chain,
    transport: http(config.rpcUrl),
    account,
  });

  const bot = new LiquidationBot({
    logTag: "[Bot] ",
    walletClient,
    publicClient,
    controllerAddress: config.controllerAddress,
    vaultSwapAddress: config.vaultSwapAddress,
    debtTokenAddress: config.debtTokenAddress,
    wbtcAddress: config.wbtcAddress,
    ponderUrl: config.ponderUrl,
  });

  await bot.logBalance();

  console.log(`Polling every ${config.pollingIntervalMs / 1000}s...`);
  console.log("---");

  await bot.run();

  setInterval(async () => {
    console.log("---");
    console.log(`[${new Date().toISOString()}] Checking...`);
    await bot.run();
  }, config.pollingIntervalMs);
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
