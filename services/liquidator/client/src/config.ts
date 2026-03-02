import type { Address, Hex } from "viem";
import type { Config } from "./types";

export function loadConfig(): Config {
  const requiredEnvVars = [
    "LIQUIDATOR_PRIVATE_KEY",
    "PONDER_URL",
    "CLIENT_RPC_URL",
    "CONTROLLER_ADDRESS",
    "LENS_ADDRESS",
    "WBTC_ADDRESS",
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  // Optional: explicit debt token addresses (overrides auto-discovery from Spoke)
  let debtTokenAddresses: Address[] | undefined;

  if (process.env.DEBT_TOKEN_ADDRESSES) {
    debtTokenAddresses = process.env.DEBT_TOKEN_ADDRESSES.split(",")
      .map((addr) => addr.trim() as Address)
      .filter((addr) => addr.length > 0);

    if (debtTokenAddresses.length === 0) {
      debtTokenAddresses = undefined;
    }
  }

  return {
    liquidatorPrivateKey: process.env.LIQUIDATOR_PRIVATE_KEY as Hex,
    pollingIntervalMs: Number.parseInt(process.env.POLLING_INTERVAL_MS || "10000", 10),
    ponderUrl: process.env.PONDER_URL!,
    rpcUrl: process.env.CLIENT_RPC_URL!,
    controllerAddress: process.env.CONTROLLER_ADDRESS as Address,
    lensAddress: process.env.LENS_ADDRESS as Address,
    wbtcAddress: process.env.WBTC_ADDRESS as Address,
    debtTokenAddresses,
    btcRedeemKey: (process.env.BTC_REDEEM_KEY ||
      "0x0000000000000000000000000000000000000000000000000000000000000000") as Hex,
    metricsPort: Number.parseInt(process.env.METRICS_PORT || "9090", 10),
  };
}
