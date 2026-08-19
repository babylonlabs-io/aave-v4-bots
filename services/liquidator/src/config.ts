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
  parseEnv,
  portSchema,
  positiveIntSchema,
  riskEnvFields,
  runtimeEnvFields,
  urlSchema,
} from "@repo/config";
import { type LiquidationEngineParams, buildFundingParams } from "@repo/engine";
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
export interface Config extends LiquidationEngineParams, RiskSettings, IndexerSettings {
  /** Indexer base URL — the composition root builds the client, health probe and ready wait from it. */
  ponderUrl: string;
  /**
   * The process's retry policy. Applied to the RPC transport by `startRuntime`, and to the indexer
   * client here — one policy, both protocols.
   */
  retryConfig: RetryConfig;
  // RPC endpoint the bot's viem clients connect to
  rpcUrl: string;

  // Poll-loop interval
  pollingIntervalMs: number;

  // Metrics/health HTTP server port
  metricsPort: number;
  /** Interface the metrics/health server binds; unset ⇒ every interface. */
  metricsHost?: string;

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

  // Indexer-liveness thresholds. Unset ⇒ the guard is off.
  ...indexerEnvFields,

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

  // The process's retry policy: applied to the indexer client here, and to the RPC transport by
  // `startRuntime`. The two honour different parts of it — viem's transport takes only the attempt
  // count and the initial delay, and runs its own uncapped exponential schedule — so
  // `RETRY_MAX_DELAY_MS` bounds indexer reads only. It matters when `maxAttempts` is raised: at
  // three attempts neither path's backoff exceeds ~2s.
  RETRY_MAX_ATTEMPTS: positiveIntSchema.optional().default("3"),
  RETRY_INITIAL_DELAY_MS: positiveIntSchema.optional().default("1000"),
  RETRY_MAX_DELAY_MS: positiveIntSchema.optional().default("5000"),
  METRICS_PORT: portSchema.optional().default("9090"),
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
  TX_RECEIPT_TIMEOUT_MS: positiveIntSchema.optional().default("120000"),

  // ── Flash funding ──────────────────────────────────────────────────────────────────────
  // `inventory` (default) repays from this signer's own inventory. `flash` routes through
  // LiquidationRouter, which borrows each debt token from a venue and repays itself out of the
  // seized collateral — the signer then needs no debt-token inventory at all, only gas.
  LIQUIDATION_FUNDING: z.enum(["inventory", "flash"]).optional().default("inventory"),
  /** LiquidationRouter deployment. Its immutable `owner` must be this bot's signer. */
  LIQUIDATION_ROUTER_ADDRESS: addressSchema.optional(),
  /** The `UniswapV4SwapVenue` bound to that router. */
  FLASH_SWAP_VENUE_ADDRESS: addressSchema.optional(),
  /**
   * One `token:currency0:currency1:fee:tickSpacing[:hooks]` per debt token, comma-separated.
   * Each pool must be WBTC/<token> — the venue repays in the pool's *other* side, so anything else
   * leaves a debt we cannot settle.
   */
  FLASH_SWAP_POOLS: z.string().optional(),
  /** Where WBTC is flash-*loaned* for the fairness payment: repaid in WBTC, which we hold. */
  WBTC_FLASH_LOAN_ADDRESS: addressSchema.optional(),
  WBTC_FLASH_LOAN_VENUE: z.enum(["morpho", "aavev3"]).optional().default("morpho"),
  /**
   * How far the realised profit may fall below the probe's quote before the chain reverts, in bps.
   * With flash-swap funding this is the only slippage bound there is — the venue fills at whatever
   * price the pool gives. Distinct from `RISK_MIN_PROFIT`, which is an absolute floor checked
   * off-chain before sending; this one is relative and enforced on-chain at execution. When both
   * are set the on-chain floor is whichever binds harder.
   */
  FLASH_MAX_SLIPPAGE_BPS: bpsSchema.optional().default("2000"),
});

export function loadConfig(): Config {
  const env = parseEnv(envSchema);

  // An empty/whitespace-only list parses to []; treat that as "auto-discover".
  const debtTokenAddresses =
    env.DEBT_TOKEN_ADDRESSES && env.DEBT_TOKEN_ADDRESSES.length > 0
      ? (env.DEBT_TOKEN_ADDRESSES as Address[])
      : undefined;

  const funding = buildFundingParams(env);

  // A profit floor is enforceable here only under flash funding, which probes the router and hands
  // the gate a real WBTC figure. Inventory funding cannot price its own actions, so the floor would
  // silently gate nothing.
  const risk = buildRiskConfig(env);
  assertProfitFloorEnforceable(risk, funding.mode === "inventory");

  return {
    ...risk,
    ...buildIndexerConfig(env),
    retryConfig: {
      maxAttempts: Number.parseInt(env.RETRY_MAX_ATTEMPTS, 10),
      initialDelayMs: Number.parseInt(env.RETRY_INITIAL_DELAY_MS, 10),
      maxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS, 10),
      backoffMultiplier: 2,
    },
    funding,
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
    metricsHost: env.METRICS_HOST,
    txReceiptTimeoutMs: Number.parseInt(env.TX_RECEIPT_TIMEOUT_MS, 10),
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
  };
}
