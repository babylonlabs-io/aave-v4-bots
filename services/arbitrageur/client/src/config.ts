import type { Address, Hex } from "viem";
import { z } from "zod";

/**
 * Address schema (0x + 40 hex chars)
 */
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address");

/**
 * Private key schema (0x + 64 hex chars)
 */
const privateKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid private key");

/**
 * URL schema
 */
const urlSchema = z.string().url("Invalid URL");

/**
 * Positive integer schema for numeric env vars
 */
const positiveIntSchema = z
  .string()
  .refine((val) => !Number.isNaN(Number.parseInt(val, 10)), "Must be a valid integer")
  .refine((val) => Number.parseInt(val, 10) > 0, "Must be a positive integer");

/**
 * Non-negative integer schema for numeric env vars
 */
const nonNegativeIntSchema = z
  .string()
  .refine((val) => !Number.isNaN(Number.parseInt(val, 10)), "Must be a valid integer")
  .refine((val) => Number.parseInt(val, 10) >= 0, "Must be a non-negative integer");

/**
 * Environment variables schema
 */
const envSchema = z.object({
  // Required
  ARBITRAGEUR_PRIVATE_KEY: privateKeySchema,
  PONDER_URL: urlSchema,
  CLIENT_RPC_URL: urlSchema,
  CONTROLLER_ADDRESS: addressSchema,
  VAULT_SWAP_ADDRESS: addressSchema,
  WBTC_ADDRESS: addressSchema,

  // Optional with defaults (validated as positive/non-negative integers)
  POLLING_INTERVAL_MS: positiveIntSchema.optional().default("30000"),
  VAULT_PROCESSING_DELAY_MS: nonNegativeIntSchema.optional().default("5000"),
  MAX_SLIPPAGE_BPS: nonNegativeIntSchema.optional().default("100"),
  AUTO_REDEEM: z.string().optional().default("true"),
  METRICS_PORT: positiveIntSchema.optional().default("9091"),

  // Retry configuration (optional)
  RETRY_MAX_ATTEMPTS: positiveIntSchema.optional().default("3"),
  RETRY_INITIAL_DELAY_MS: positiveIntSchema.optional().default("1000"),
  RETRY_MAX_DELAY_MS: positiveIntSchema.optional().default("30000"),

  // Transaction timeout (optional)
  TX_RECEIPT_TIMEOUT_MS: positiveIntSchema.optional().default("120000"),
});

/**
 * Parsed and validated configuration
 */
export interface Config {
  // Arbitrageur
  arbitrageurPrivateKey: Hex;

  // URLs
  ponderUrl: string;
  rpcUrl: string;

  // Contract addresses
  controllerAddress: Address;
  vaultSwapAddress: Address;
  wbtcAddress: Address;

  // Timing
  pollingIntervalMs: number;
  vaultProcessingDelayMs: number;

  // Trading
  maxSlippageBps: number;

  // Behavior
  autoRedeem: boolean;

  // Monitoring
  metricsPort: number;

  // Retry configuration
  retryMaxAttempts: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;

  // Transaction timeout
  txReceiptTimeoutMs: number;
}

/**
 * Load and validate configuration from environment variables.
 * Fails fast with clear error messages if validation fails.
 */
export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Configuration validation failed:");
    console.error("");

    for (const error of result.error.errors) {
      const path = error.path.join(".");
      console.error(`  ✗ ${path}: ${error.message}`);
    }

    console.error("");
    console.error("Please check your .env file and ensure all required variables are set.");
    process.exit(1);
  }

  const env = result.data;

  return {
    arbitrageurPrivateKey: env.ARBITRAGEUR_PRIVATE_KEY as Hex,
    ponderUrl: env.PONDER_URL,
    rpcUrl: env.CLIENT_RPC_URL,
    controllerAddress: env.CONTROLLER_ADDRESS as Address,
    vaultSwapAddress: env.VAULT_SWAP_ADDRESS as Address,
    wbtcAddress: env.WBTC_ADDRESS as Address,
    pollingIntervalMs: Number.parseInt(env.POLLING_INTERVAL_MS, 10),
    vaultProcessingDelayMs: Number.parseInt(env.VAULT_PROCESSING_DELAY_MS, 10),
    maxSlippageBps: Number.parseInt(env.MAX_SLIPPAGE_BPS, 10),
    autoRedeem: env.AUTO_REDEEM === "true",
    metricsPort: Number.parseInt(env.METRICS_PORT, 10),
    retryMaxAttempts: Number.parseInt(env.RETRY_MAX_ATTEMPTS, 10),
    retryInitialDelayMs: Number.parseInt(env.RETRY_INITIAL_DELAY_MS, 10),
    retryMaxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS, 10),
    txReceiptTimeoutMs: Number.parseInt(env.TX_RECEIPT_TIMEOUT_MS, 10),
  };
}
