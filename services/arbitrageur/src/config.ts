import {
  addressSchema,
  nonNegativeIntSchema,
  parseEnv,
  positiveIntSchema,
  privateKeySchema,
  urlSchema,
} from "@repo/config";
import type { ArbitrageEngineParams } from "@repo/engine";
import type { Address, Hex } from "viem";
import { z } from "zod";

/**
 * Environment variables schema
 */
const envSchema = z.object({
  // Required
  ARBITRAGEUR_PRIVATE_KEY: privateKeySchema,
  PONDER_URL: urlSchema,
  CLIENT_RPC_URL: urlSchema,
  VAULT_SWAP_ADDRESS: addressSchema,
  WBTC_ADDRESS: addressSchema,

  // Optional with defaults (validated as positive/non-negative integers)
  POLLING_INTERVAL_MS: positiveIntSchema.optional().default("30000"),
  VAULT_PROCESSING_DELAY_MS: nonNegativeIntSchema.optional().default("5000"),
  MAX_SLIPPAGE_BPS: nonNegativeIntSchema.optional().default("100"),
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
// The engine's domain params (addresses, ponder URL, slippage, delays, tx
// timeout) are declared in `@repo/engine` and inherited here; this interface
// only adds the composition-root fields the service needs to wire the engine up.
export interface Config extends ArbitrageEngineParams {
  // Signer for the bot's wallet client
  arbitrageurPrivateKey: Hex;

  // RPC endpoint the bot's viem clients connect to
  rpcUrl: string;

  // Poll-loop interval
  pollingIntervalMs: number;

  // Metrics/health HTTP server port
  metricsPort: number;

  // Retry configuration — parsed into a `RetryConfig` object at wiring time
  retryMaxAttempts: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
}

/**
 * Load and validate configuration from environment variables.
 * Fails fast with clear error messages if validation fails.
 */
export function loadConfig(): Config {
  const env = parseEnv(envSchema);

  return {
    arbitrageurPrivateKey: env.ARBITRAGEUR_PRIVATE_KEY as Hex,
    ponderUrl: env.PONDER_URL,
    rpcUrl: env.CLIENT_RPC_URL,
    vaultSwapAddress: env.VAULT_SWAP_ADDRESS as Address,
    wbtcAddress: env.WBTC_ADDRESS as Address,
    pollingIntervalMs: Number.parseInt(env.POLLING_INTERVAL_MS, 10),
    vaultProcessingDelayMs: Number.parseInt(env.VAULT_PROCESSING_DELAY_MS, 10),
    maxSlippageBps: Number.parseInt(env.MAX_SLIPPAGE_BPS, 10),
    metricsPort: Number.parseInt(env.METRICS_PORT, 10),
    retryMaxAttempts: Number.parseInt(env.RETRY_MAX_ATTEMPTS, 10),
    retryInitialDelayMs: Number.parseInt(env.RETRY_INITIAL_DELAY_MS, 10),
    retryMaxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS, 10),
    txReceiptTimeoutMs: Number.parseInt(env.TX_RECEIPT_TIMEOUT_MS, 10),
  };
}
