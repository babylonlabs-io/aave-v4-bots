import type { Address, Hex } from "viem";
import type { Config } from "./types";

const BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

function assertAddress(name: string, value: string): asserts value is Address {
  if (!ADDRESS_REGEX.test(value)) {
    throw new Error(`Invalid ${name}: must be a 0x-prefixed 20-byte hex address`);
  }
}

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

  const liquidatorPrivateKey = process.env.LIQUIDATOR_PRIVATE_KEY!;
  if (!PRIVATE_KEY_REGEX.test(liquidatorPrivateKey)) {
    throw new Error("Invalid LIQUIDATOR_PRIVATE_KEY: must be 0x-prefixed 32-byte hex");
  }

  const controllerAddress = process.env.CONTROLLER_ADDRESS!;
  const lensAddress = process.env.LENS_ADDRESS!;
  const wbtcAddress = process.env.WBTC_ADDRESS!;
  assertAddress("CONTROLLER_ADDRESS", controllerAddress);
  assertAddress("LENS_ADDRESS", lensAddress);
  assertAddress("WBTC_ADDRESS", wbtcAddress);

  // Optional: explicit debt token addresses (overrides auto-discovery from Spoke)
  let debtTokenAddresses: Address[] | undefined;

  if (process.env.DEBT_TOKEN_ADDRESSES) {
    debtTokenAddresses = process.env.DEBT_TOKEN_ADDRESSES.split(",")
      .map((addr) => addr.trim() as Address)
      .filter((addr) => addr.length > 0);

    if (debtTokenAddresses.length === 0) {
      debtTokenAddresses = undefined;
    } else {
      for (const tokenAddress of debtTokenAddresses) {
        assertAddress("DEBT_TOKEN_ADDRESSES item", tokenAddress);
      }
    }
  }

  const btcRedeemKey =
    process.env.BTC_REDEEM_KEY ||
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  if (!BYTES32_REGEX.test(btcRedeemKey)) {
    throw new Error("Invalid BTC_REDEEM_KEY: must be 0x-prefixed 32-byte hex");
  }

  const txReceiptTimeoutMs = Number.parseInt(process.env.TX_RECEIPT_TIMEOUT_MS || "120000", 10);
  if (!Number.isFinite(txReceiptTimeoutMs) || txReceiptTimeoutMs <= 0) {
    throw new Error("Invalid TX_RECEIPT_TIMEOUT_MS: must be a positive integer");
  }

  return {
    liquidatorPrivateKey: liquidatorPrivateKey as Hex,
    pollingIntervalMs: Number.parseInt(process.env.POLLING_INTERVAL_MS || "10000", 10),
    ponderUrl: process.env.PONDER_URL!,
    rpcUrl: process.env.CLIENT_RPC_URL!,
    controllerAddress,
    lensAddress,
    wbtcAddress,
    debtTokenAddresses,
    btcRedeemKey: btcRedeemKey as Hex,
    metricsPort: Number.parseInt(process.env.METRICS_PORT || "9090", 10),
    txReceiptTimeoutMs,
  };
}
