import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.liquidator from root directory
dotenvConfig({ path: resolve(process.cwd(), ".env.liquidator") });

import { http, type Chain, type Hex, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { LiquidationBot } from "./bot";
import { loadConfig } from "./config";
import { updateLastPollTime } from "./health";
import { setPublicClient, startMetricsServer } from "./server";
import type { Config } from "./types";

async function createBot(config: Config) {
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
    lensAddress: config.lensAddress,
    wbtcAddress: config.wbtcAddress,
    debtTokenAddresses: config.debtTokenAddresses,
    btcRedeemKey: config.btcRedeemKey,
    isDirectRedemption: config.isDirectRedemption,
    llpAddress: config.llpAddress,
    ponderUrl: config.ponderUrl,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
  });

  return { bot, publicClient };
}

async function main() {
  const command = process.argv[2] || "poll";
  const config = loadConfig();

  if (command === "poll") {
    console.log("Aave V4 Liquidation Bot Starting...");
    const { bot, publicClient } = await createBot(config);

    // Start metrics server
    setPublicClient(publicClient);
    startMetricsServer({
      port: config.metricsPort,
      ponderUrl: config.ponderUrl,
    });

    // Discover or use configured debt tokens
    if (config.debtTokenAddresses) {
      console.log(
        `Using ${config.debtTokenAddresses.length} debt token(s) from DEBT_TOKEN_ADDRESSES env var`
      );
    } else {
      await bot.discoverDebtTokens();
    }

    await bot.ensureApproval();
    await bot.logBalances();

    console.log(
      `Redemption mode: ${config.isDirectRedemption ? "direct BTC" : "WBTC via VaultSwap"}`
    );
    console.log(`Polling every ${config.pollingIntervalMs / 1000}s...`);
    console.log("---");

    // Run loop — awaits each run before sleeping to prevent overlapping executions
    while (true) {
      console.log(`[${new Date().toISOString()}] Checking...`);
      await bot.run();
      await bot.logBalances();
      updateLastPollTime();
      console.log("---");
      await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
    }
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Available commands: poll (default)");
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
