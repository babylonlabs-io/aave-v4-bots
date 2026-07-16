import {
  type ExecutionSettings,
  type NotifierSettings,
  type RiskSettings,
  addressListSchema,
  addressSchema,
  buildExecutionConfig,
  buildNotifierConfig,
  buildPersistenceConfig,
  buildRiskConfig,
  buildSecretsConfig,
  bytes32Schema,
  parseEnv,
  positiveIntSchema,
  riskEnvFields,
  runtimeEnvFields,
  urlSchema,
} from "@repo/config";
import type { LiquidationEngineParams } from "@repo/engine";
import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { type SignerConfig, buildSignerConfig } from "@repo/signer";
import type { Address, Hex } from "viem";
import { z } from "zod";

/** Default key ref for the `local` signer — preserves the pre-config-selection behavior. */
const DEFAULT_KEY_REF = "LIQUIDATOR_PRIVATE_KEY";

// The engine's domain params (addresses, ponder URL, redemption flags, tx
// timeout) are declared in `@repo/engine` and inherited here; this interface
// only adds the composition-root fields the service needs to wire the engine up.
export interface Config extends LiquidationEngineParams, RiskSettings {
  // RPC endpoint the bot's viem clients connect to
  rpcUrl: string;

  // Poll-loop interval
  pollingIntervalMs: number;

  // Metrics/health HTTP server port
  metricsPort: number;

  // Where secrets are resolved from, and how the signer is obtained. Resolved into a
  // `SecretsProvider` + `Signer` at boot (index.ts); no key material lives in `Config`.
  secrets: SecretsConfig;
  signer: SignerConfig;

  // Crash-safety persistence. Present iff DATABASE_URL is set — otherwise the bot runs
  // without a StateStore (in-memory nonce sequencing, no idempotency), unchanged.
  persistence?: PersistenceConfig;

  // Outbound alerts (risk halts, and MANUAL proposals). The Slack webhook is resolved from a
  // secret ref at boot (index.ts); `none` (default) logs only.
  notifier: NotifierSettings;

  // Execution mode. AUTO (default) signs + broadcasts; MANUAL is keyless — persists proposals and
  // notifies an operator. In MANUAL the boot resolves no signing key (see index.ts).
  execution: ExecutionSettings;
}

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// The signing key is a secret resolved at boot via `@repo/secrets`, not a config
// field — see index.ts. This schema only selects *where* the signer and secrets come
// from; the key material itself never appears here.
const envSchema = z.object({
  // Secrets/signer source selection + crash-safety persistence, shared by every bot service.
  ...runtimeEnvFields,

  // Risk gate thresholds + kill-switch (all optional; unset ⇒ the guard is off, which is the
  // pre-existing permissive behavior).
  ...riskEnvFields,

  // Required
  PONDER_URL: urlSchema,
  CLIENT_RPC_URL: urlSchema,
  ADAPTER_ADDRESS: addressSchema,
  LENS_ADDRESS: addressSchema,
  WBTC_ADDRESS: addressSchema,

  // Optional
  DEBT_TOKEN_ADDRESSES: addressListSchema.optional(),
  BTC_REDEEM_KEY: bytes32Schema.optional().default(ZERO_BYTES32),
  IS_DIRECT_REDEMPTION: z.string().optional(),
  LLP_ADDRESS: addressSchema.optional().default(ZERO_ADDRESS),
  POLLING_INTERVAL_MS: positiveIntSchema.optional().default("12000"),
  METRICS_PORT: positiveIntSchema.optional().default("9090"),
  TX_RECEIPT_TIMEOUT_MS: positiveIntSchema.optional().default("120000"),
});

export function loadConfig(): Config {
  const env = parseEnv(envSchema);

  // An empty/whitespace-only list parses to []; treat that as "auto-discover".
  const debtTokenAddresses =
    env.DEBT_TOKEN_ADDRESSES && env.DEBT_TOKEN_ADDRESSES.length > 0
      ? (env.DEBT_TOKEN_ADDRESSES as Address[])
      : undefined;

  return {
    ...buildRiskConfig(env),
    pollingIntervalMs: Number.parseInt(env.POLLING_INTERVAL_MS, 10),
    ponderUrl: env.PONDER_URL,
    rpcUrl: env.CLIENT_RPC_URL,
    adapterAddress: env.ADAPTER_ADDRESS as Address,
    lensAddress: env.LENS_ADDRESS as Address,
    wbtcAddress: env.WBTC_ADDRESS as Address,
    debtTokenAddresses,
    btcRedeemKey: env.BTC_REDEEM_KEY as Hex,
    isDirectRedemption: env.IS_DIRECT_REDEMPTION === "true",
    llpAddress: env.LLP_ADDRESS as Address,
    metricsPort: Number.parseInt(env.METRICS_PORT, 10),
    txReceiptTimeoutMs: Number.parseInt(env.TX_RECEIPT_TIMEOUT_MS, 10),
    secrets: buildSecretsConfig(env),
    persistence: buildPersistenceConfig(env),
    notifier: buildNotifierConfig(env),
    execution: buildExecutionConfig(env),
    signer: buildSignerConfig({
      source: env.SIGNER_SOURCE,
      keyRef: env.SIGNER_KEY_REF,
      defaultKeyRef: DEFAULT_KEY_REF,
      kmsKeyId: env.KMS_KEY_ID,
      address: env.SIGNER_ADDRESS as Address | undefined,
      region: env.AWS_REGION,
    }),
  };
}
