import type { RetryConfig } from "@repo/chain";
import {
  type ExecutionSettings,
  type IndexerSettings,
  type NotifierSettings,
  type RiskSettings,
  addressListSchema,
  addressSchema,
  assertProfitFloorEnforceable,
  bpsSchema,
  buildExecutionConfig,
  buildIndexerConfig,
  buildNotifierConfig,
  buildPersistenceConfig,
  buildRiskConfig,
  buildSecretsConfig,
  bytes32Schema,
  indexerEnvFields,
  nonNegativeIntSchema,
  parseEnv,
  portSchema,
  positiveIntSchema,
  riskEnvFields,
  runtimeEnvFields,
  urlSchema,
} from "@repo/config";
import {
  type ArbitrageEngineParams,
  type LiquidationEngineParams,
  buildArbitrageFundingParams,
  buildFundingParams,
} from "@repo/engine";
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

  // Indexer-liveness thresholds. Unset ⇒ the guard is off.
  ...indexerEnvFields,

  // Required
  PONDER_URL: urlSchema,
  CLIENT_RPC_URL: urlSchema,
  VAULT_SWAP_ADDRESS: addressSchema,
  WBTC_ADDRESS: addressSchema,

  // Registered vault keeper the acquired vault is redeemed to (optional). Set it when whoever
  // signs is not itself a keeper — the bot pays the WBTC and that keeper receives the vault via
  // `swapWbtcForVaultOnBehalf`. Unset ⇒ the executor must be a keeper and pays for itself.
  VAULT_KEEPER_ADDRESS: addressSchema.optional(),

  // Where the WBTC for an acquisition comes from. `router` has a treasury pay through an
  // `ArbitrageRouter`, so this bot's key needs only gas. Guarded two-ways in
  // `buildArbitrageFundingParams`.
  ARBITRAGE_FUNDING: z.enum(["inventory", "router"]).optional().default("inventory"),
  ARBITRAGE_ROUTER_ADDRESS: addressSchema.optional(),
  ARBITRAGE_RELAY_DEADLINE_SECONDS: positiveIntSchema.optional().default("120"),

  // Optional with defaults (validated as positive/non-negative integers)
  POLLING_INTERVAL_MS: positiveIntSchema.optional().default("30000"),
  // 0 = off. Acquisitions are batched (send-all, then batch-wait), so this is now an opt-in
  // throttle between broadcasts for rate-limited RPCs — not a per-acquisition pause.
  VAULT_PROCESSING_DELAY_MS: nonNegativeIntSchema.optional().default("0"),
  MAX_SLIPPAGE_BPS: bpsSchema.optional().default("100"),
  METRICS_PORT: portSchema.optional().default("9091"),
  /**
   * Interface the metrics/health server binds. Unset ⇒ every interface, which is what a container
   * publishing this port to a scrape network needs — and what this has always done.
   *
   * Worth setting on a host where the port is not already behind a network policy: `/metrics` is
   * unauthenticated, and its gauges carry the signer and treasury addresses, their live balances,
   * and the allowance standing to the router. Each is on chain, but the endpoint hands over the
   * process-to-address linkage in one place, to a caller who needed to know no addresses first.
   * `RISK_CONTROL_HOST` is the same knob for the kill switch, which defaults to loopback instead.
   */
  METRICS_HOST: z.string().min(1).optional(),

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

  // ── Flash funding (liquidation mode only) ──────────────────────────────────────────────
  // Identical to the liquidator's — the same `LiquidationEngine` runs here, so it is configured
  // the same way. See services/liquidator/src/config.ts for what each one means.
  LIQUIDATION_FUNDING: z.enum(["inventory", "flash"]).optional().default("inventory"),
  LIQUIDATION_ROUTER_ADDRESS: addressSchema.optional(),
  FLASH_SWAP_VENUE_ADDRESS: addressSchema.optional(),
  FLASH_SWAP_POOLS: z.string().optional(),
  WBTC_FLASH_LOAN_ADDRESS: addressSchema.optional(),
  WBTC_FLASH_LOAN_VENUE: z.enum(["morpho", "aavev3"]).optional().default("morpho"),
  FLASH_MAX_SLIPPAGE_BPS: bpsSchema.optional().default("2000"),
});

/** The liquidation engine's params plus its own poll interval — present iff enabled. */
export type LiquidationRunConfig = LiquidationEngineParams & { pollingIntervalMs: number };

/**
 * Parsed and validated configuration
 */
// The engine's domain params (addresses, ponder URL, slippage, delays, tx
// timeout) are declared in `@repo/engine` and inherited here; this interface
// only adds the composition-root fields the service needs to wire the engine up.
export interface Config extends ArbitrageEngineParams, RiskSettings, IndexerSettings {
  /** Indexer base URL — the composition root builds the client, health probe and ready wait from it. */
  ponderUrl: string;
  // RPC endpoint the bot's viem clients connect to
  rpcUrl: string;

  // Poll-loop interval
  pollingIntervalMs: number;

  // Metrics/health HTTP server port
  metricsPort: number;
  /** Interface the metrics/health server binds; unset ⇒ every interface. */
  metricsHost?: string;

  // How the bot retries the indexer. Both engines this process may run take it as-is.
  retryConfig: RetryConfig;

  // Where secrets are resolved from, and how the signer is obtained. Resolved into a
  // `SecretsProvider` + `Signer` at boot (index.ts); no key material lives in `Config`.
  secrets: SecretsConfig;
  signer: SignerConfig;

  // Crash-safety persistence for the liquidation engine. Present iff DATABASE_URL is set.
  persistence?: PersistenceConfig;

  // Outbound alerts (risk halts, and MANUAL proposals). Slack webhook resolved from a secret ref
  // at boot (index.ts); `none` (default) logs only.
  notifier: NotifierSettings;

  // Execution mode — per PROCESS, so it covers BOTH engines this service may run. AUTO (default)
  // signs + broadcasts; MANUAL is keyless (one shared `ManualExecutor` injected into both engines).
  execution: ExecutionSettings;

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

  // Assembled once: both the arbitrage engine and the opt-in liquidation engine read the same
  // indexer, so they retry it the same way.
  const retryConfig = {
    maxAttempts: Number.parseInt(env.RETRY_MAX_ATTEMPTS, 10),
    initialDelayMs: Number.parseInt(env.RETRY_INITIAL_DELAY_MS, 10),
    maxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS, 10),
    backoffMultiplier: 2,
  };

  const debtTokenAddresses =
    env.DEBT_TOKEN_ADDRESSES && env.DEBT_TOKEN_ADDRESSES.length > 0
      ? (env.DEBT_TOKEN_ADDRESSES as Address[])
      : undefined;

  // Funding is a property of the liquidation engine, so a flash setup without that engine is
  // configuration that can never take effect. Rejecting it matches how a half-set ADAPTER/LENS pair
  // is treated above: the operator asked for something this process will not do.
  const funding = buildFundingParams(env);
  if (funding.mode === "flash" && !env.ADAPTER_ADDRESS) {
    throw new Error(
      "LIQUIDATION_FUNDING=flash has no effect without the liquidation engine — set ADAPTER_ADDRESS " +
        "+ LENS_ADDRESS to enable it, or drop the flash configuration."
    );
  }

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
          funding,
          txReceiptTimeoutMs,
          pollingIntervalMs: Number.parseInt(env.LIQUIDATION_POLLING_INTERVAL_MS, 10),
        }
      : undefined;

  // Arbitrage prices its own actions, so the floor is always enforceable for it. What can make it
  // unenforceable is an *inventory-funded* liquidation engine, which cannot. A flash-funded one
  // probes the router and declares a real expected profit, so it does not.
  const risk = buildRiskConfig(env);
  assertProfitFloorEnforceable(risk, liquidation !== undefined && funding.mode === "inventory");

  return {
    ...risk,
    ...buildIndexerConfig(env),
    ponderUrl,
    rpcUrl: env.CLIENT_RPC_URL,
    vaultSwapAddress: env.VAULT_SWAP_ADDRESS as Address,
    wbtcAddress,
    vaultKeeperAddress: env.VAULT_KEEPER_ADDRESS as Address | undefined,
    funding: buildArbitrageFundingParams(env),
    pollingIntervalMs: Number.parseInt(env.POLLING_INTERVAL_MS, 10),
    vaultProcessingDelayMs: Number.parseInt(env.VAULT_PROCESSING_DELAY_MS, 10),
    maxSlippageBps: Number.parseInt(env.MAX_SLIPPAGE_BPS, 10),
    metricsPort: Number.parseInt(env.METRICS_PORT, 10),
    metricsHost: env.METRICS_HOST,
    retryConfig,
    txReceiptTimeoutMs,
    secrets: buildSecretsConfig(env),
    persistence: buildPersistenceConfig(env),
    notifier: buildNotifierConfig(env),
    // Pass whether the effective signing-key env var actually holds a value, so a MANUAL boot
    // rejects a raw key left in the process env (see `buildExecutionConfig`).
    execution: buildExecutionConfig(env, {
      signerKeyPresent: Boolean(process.env[env.SIGNER_KEY_REF ?? DEFAULT_KEY_REF]),
    }),
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
