import {
  type RiskSettings,
  addressListSchema,
  addressSchema,
  buildPersistenceConfig,
  buildRiskConfig,
  buildSecretsConfig,
  bytes32Schema,
  nonNegativeIntSchema,
  parseEnv,
  positiveIntSchema,
  riskEnvFields,
  runtimeEnvFields,
  urlSchema,
} from "@repo/config";
import type { ArbitrageEngineParams, LiquidationEngineParams } from "@repo/engine";
import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { type SignerConfig, buildSignerConfig } from "@repo/signer";
import type { Address, Hex } from "viem";
import { z } from "zod";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Default key ref for the `local` signer — preserves the pre-config-selection behavior. */
const DEFAULT_KEY_REF = "ARBITRAGEUR_PRIVATE_KEY";

/**
 * Environment variables schema
 */
// The signing key is a secret resolved at boot via `@repo/secrets`, not a config
// field — see index.ts.
const envSchema = z.object({
  // Secrets/signer source selection + crash-safety persistence, shared by every bot service.
  // Both engines the arbitrageur may run share the one signer these fields select.
  ...runtimeEnvFields,

  // Risk gate thresholds + kill-switch (all optional; unset ⇒ the guard is off, which is the
  // pre-existing permissive behavior). One gate is shared by BOTH engines this process runs.
  ...riskEnvFields,

  // Required
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

  // Optional liquidation mode — when ADAPTER_ADDRESS + LENS_ADDRESS are set, the
  // arbitrageur also runs the LiquidationEngine (both engines, one process). Unset
  // ⇒ arbitrage-only (unchanged). Reuses WBTC_ADDRESS / PONDER_URL / the signer.
  ADAPTER_ADDRESS: addressSchema.optional(),
  LENS_ADDRESS: addressSchema.optional(),
  BTC_REDEEM_KEY: bytes32Schema.optional().default(ZERO_BYTES32),
  IS_DIRECT_REDEMPTION: z.string().optional(),
  LLP_ADDRESS: addressSchema.optional().default(ZERO_ADDRESS),
  DEBT_TOKEN_ADDRESSES: addressListSchema.optional(),
  LIQUIDATION_POLLING_INTERVAL_MS: positiveIntSchema.optional().default("12000"),
});

/** The liquidation engine's params plus its own poll interval — present iff enabled. */
export type LiquidationRunConfig = LiquidationEngineParams & { pollingIntervalMs: number };

/**
 * Parsed and validated configuration
 */
// The engine's domain params (addresses, ponder URL, slippage, delays, tx
// timeout) are declared in `@repo/engine` and inherited here; this interface
// only adds the composition-root fields the service needs to wire the engine up.
export interface Config extends ArbitrageEngineParams, RiskSettings {
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

  // Where secrets are resolved from, and how the signer is obtained. Resolved into a
  // `SecretsProvider` + `Signer` at boot (index.ts); no key material lives in `Config`.
  secrets: SecretsConfig;
  signer: SignerConfig;

  // Crash-safety persistence for the liquidation engine. Present iff DATABASE_URL is set.
  persistence?: PersistenceConfig;

  // Present iff the arbitrageur also runs the LiquidationEngine (opt-in via env).
  liquidation?: LiquidationRunConfig;
}

/**
 * Load and validate configuration from environment variables.
 * Fails fast with clear error messages if validation fails.
 */
export function loadConfig(): Config {
  const env = parseEnv(envSchema);

  // A half-configured liquidation mode is almost certainly a typo — fail loudly.
  if (!!env.ADAPTER_ADDRESS !== !!env.LENS_ADDRESS) {
    throw new Error(
      "Arbitrageur liquidation mode requires BOTH ADAPTER_ADDRESS and LENS_ADDRESS (set both or neither)."
    );
  }

  const wbtcAddress = env.WBTC_ADDRESS as Address;
  const ponderUrl = env.PONDER_URL;
  const txReceiptTimeoutMs = Number.parseInt(env.TX_RECEIPT_TIMEOUT_MS, 10);

  const debtTokenAddresses =
    env.DEBT_TOKEN_ADDRESSES && env.DEBT_TOKEN_ADDRESSES.length > 0
      ? (env.DEBT_TOKEN_ADDRESSES as Address[])
      : undefined;

  const liquidation: LiquidationRunConfig | undefined =
    env.ADAPTER_ADDRESS && env.LENS_ADDRESS
      ? {
          adapterAddress: env.ADAPTER_ADDRESS as Address,
          lensAddress: env.LENS_ADDRESS as Address,
          wbtcAddress,
          debtTokenAddresses,
          btcRedeemKey: env.BTC_REDEEM_KEY as Hex,
          isDirectRedemption: env.IS_DIRECT_REDEMPTION === "true",
          llpAddress: env.LLP_ADDRESS as Address,
          ponderUrl,
          txReceiptTimeoutMs,
          pollingIntervalMs: Number.parseInt(env.LIQUIDATION_POLLING_INTERVAL_MS, 10),
        }
      : undefined;

  return {
    ...buildRiskConfig(env),
    ponderUrl,
    rpcUrl: env.CLIENT_RPC_URL,
    vaultSwapAddress: env.VAULT_SWAP_ADDRESS as Address,
    wbtcAddress,
    pollingIntervalMs: Number.parseInt(env.POLLING_INTERVAL_MS, 10),
    vaultProcessingDelayMs: Number.parseInt(env.VAULT_PROCESSING_DELAY_MS, 10),
    maxSlippageBps: Number.parseInt(env.MAX_SLIPPAGE_BPS, 10),
    metricsPort: Number.parseInt(env.METRICS_PORT, 10),
    retryMaxAttempts: Number.parseInt(env.RETRY_MAX_ATTEMPTS, 10),
    retryInitialDelayMs: Number.parseInt(env.RETRY_INITIAL_DELAY_MS, 10),
    retryMaxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS, 10),
    txReceiptTimeoutMs,
    secrets: buildSecretsConfig(env),
    persistence: buildPersistenceConfig(env),
    signer: buildSignerConfig({
      source: env.SIGNER_SOURCE,
      keyRef: env.SIGNER_KEY_REF,
      defaultKeyRef: DEFAULT_KEY_REF,
      kmsKeyId: env.KMS_KEY_ID,
      address: env.SIGNER_ADDRESS as Address | undefined,
      region: env.AWS_REGION,
    }),
    liquidation,
  };
}
