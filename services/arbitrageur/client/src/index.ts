import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

// Load .env.arbitrageur from root directory BEFORE importing config
dotenvConfig({ path: resolve(process.cwd(), ".env.arbitrageur") });

import {
  http,
  type Chain,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ArbitrageurBot } from "./bot";
import { type Config, loadConfig } from "./config";
import { setPublicClient, startMetricsServer } from "./server";

function printUsage(): void {
  console.log(`
Aave V4 Arbitrageur Bot

Usage:
  pnpm arbitrage                     Start polling mode (default)
  pnpm arbitrage verify <vaultId>    Verify on-chain ownership of a vault
  pnpm arbitrage redeem <vaultId>    Redeem a specific vault
  pnpm arbitrage list-owned          List all vaults owned by this arbitrageur
  pnpm arbitrage help                Show this help message

Environment variables:
  See env.example for required configuration
`);
}

interface BotWithClients {
  bot: ArbitrageurBot;
  publicClient: PublicClient;
}

async function createBot(config: Config): Promise<BotWithClients> {
  const account = privateKeyToAccount(config.arbitrageurPrivateKey);
  console.log(`Arbitrageur address: ${account.address}`);

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

  const bot = new ArbitrageurBot({
    logTag: "[Arbitrageur] ",
    walletClient,
    publicClient,
    controllerAddress: config.controllerAddress,
    vaultSwapAddress: config.vaultSwapAddress,
    wbtcAddress: config.wbtcAddress,
    ponderUrl: config.ponderUrl,
    maxSlippageBps: config.maxSlippageBps,
    autoRedeem: config.autoRedeem,
    vaultProcessingDelayMs: config.vaultProcessingDelayMs,
    retryConfig: {
      maxAttempts: config.retryMaxAttempts,
      initialDelayMs: config.retryInitialDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      backoffMultiplier: 2,
    },
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
  });

  return { bot, publicClient };
}

async function runPollingMode(config: Config): Promise<void> {
  console.log("Aave V4 Arbitrageur Bot Starting...");
  console.log("===================================");

  const { bot, publicClient } = await createBot(config);

  // Start metrics server
  setPublicClient(publicClient);
  startMetricsServer({
    port: config.metricsPort,
    ponderUrl: config.ponderUrl,
  });

  console.log(`Auto-redeem: ${config.autoRedeem}`);
  console.log(`Max slippage: ${config.maxSlippageBps / 100}%`);
  console.log(`Retry attempts: ${config.retryMaxAttempts}`);
  console.log(`Transaction timeout: ${config.txReceiptTimeoutMs / 1000}s`);

  // Log initial balance
  await bot.logBalance();

  console.log(`Polling every ${config.pollingIntervalMs / 1000}s...`);
  console.log(`Delay between vaults: ${config.vaultProcessingDelayMs / 1000}s`);
  console.log("---");

  // Polling loop using recursive setTimeout to prevent overlapping cycles
  const poll = async () => {
    console.log("---");
    console.log(`[${new Date().toISOString()}] Checking for escrowed vaults...`);

    try {
      await bot.run();
      bot.logOwnedVaults();
      await bot.logBalance();
    } catch (error) {
      console.error("[Arbitrageur] Unexpected error in poll cycle:", error);
    }

    // Schedule next poll after current one completes
    setTimeout(poll, config.pollingIntervalMs);
  };

  // Start first poll immediately
  await poll();
}

async function runRedeemVault(config: Config, vaultId: string): Promise<void> {
  console.log(`Redeeming vault: ${vaultId}`);
  console.log("============================");

  if (!vaultId.startsWith("0x") || vaultId.length !== 66) {
    console.error("Error: Invalid vault ID format. Expected bytes32 hex string (0x + 64 chars)");
    process.exit(1);
  }

  const { bot } = await createBot(config);
  await bot.logBalance();

  const success = await bot.redeemVault(vaultId as Hex);

  if (success) {
    console.log("Vault redeemed successfully!");
    process.exit(0);
  } else {
    console.error("Failed to redeem vault.");
    process.exit(1);
  }
}

async function runVerifyOwnership(config: Config, vaultId: string): Promise<void> {
  console.log("Verifying vault ownership...");
  console.log("============================");

  if (!vaultId.startsWith("0x") || vaultId.length !== 66) {
    console.error("Error: Invalid vault ID format. Expected bytes32 hex string (0x + 64 chars)");
    process.exit(1);
  }

  const { bot } = await createBot(config);
  const arbitrageur = privateKeyToAccount(config.arbitrageurPrivateKey).address;

  console.log(`Arbitrageur: ${arbitrageur}`);
  console.log(`Vault ID: ${vaultId}`);

  const isOwner = await bot.verifyVaultOwnership(vaultId as Hex);

  if (isOwner) {
    console.log("\nResult: You OWN this vault");
  } else {
    console.log("\nResult: You do NOT own this vault");
  }
  process.exit(0);
}

interface OwnedVaultResponse {
  vaults: Array<{
    vaultId: string;
    owner: string;
    btcAmount: string;
    wbtcPaid: string;
    acquiredAt: string;
  }>;
  total: number;
}

async function runListOwned(config: Config): Promise<void> {
  console.log("Listing owned vaults...");
  console.log("=======================");

  const arbitrageur = privateKeyToAccount(config.arbitrageurPrivateKey).address;
  console.log(`Arbitrageur: ${arbitrageur}`);
  console.log("");

  try {
    const response = await fetch(`${config.ponderUrl}/owned-vaults?owner=${arbitrageur}`);

    if (!response.ok) {
      console.error(`Failed to fetch owned vaults: ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const data = (await response.json()) as OwnedVaultResponse;

    if (data.total === 0) {
      console.log("No owned vaults found.");
      process.exit(0);
    }

    console.log(`Found ${data.total} owned vault(s):\n`);

    for (const vault of data.vaults) {
      const btcAmount = Number(vault.btcAmount) / 1e8;
      const wbtcPaid = Number(vault.wbtcPaid) / 1e8;
      const acquiredDate = new Date(Number(vault.acquiredAt) * 1000).toISOString();

      console.log(`Vault ID: ${vault.vaultId}`);
      console.log(`  BTC Amount:  ${btcAmount.toFixed(8)} BTC`);
      console.log(`  WBTC Paid:   ${wbtcPaid.toFixed(8)} WBTC`);
      console.log(`  Acquired At: ${acquiredDate}`);
      console.log("");
    }

    console.log(`Total: ${data.total} vault(s)`);
    process.exit(0);
  } catch (error) {
    console.error("Failed to fetch owned vaults:", error);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "poll";

  // Handle help command before loading config
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // Load and validate config (fails fast with clear errors)
  const config = loadConfig();

  switch (command) {
    case "poll":
    case "start":
      await runPollingMode(config);
      break;

    case "redeem": {
      const vaultId = args[1];
      if (!vaultId) {
        console.error("Error: vault ID required for redeem command");
        console.log("Usage: pnpm arbitrage redeem <vaultId>");
        process.exit(1);
      }
      await runRedeemVault(config, vaultId);
      break;
    }

    case "verify": {
      const verifyVaultId = args[1];
      if (!verifyVaultId) {
        console.error("Error: vault ID required for verify command");
        console.log("Usage: pnpm arbitrage verify <vaultId>");
        process.exit(1);
      }
      await runVerifyOwnership(config, verifyVaultId);
      break;
    }

    case "list-owned":
    case "list":
    case "owned":
      await runListOwned(config);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Graceful shutdown
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
