import {
  addressListSchema,
  addressSchema,
  bytes32Schema,
  parseEnv,
  positiveIntSchema,
  privateKeySchema,
  urlSchema,
} from "@repo/config";
import type { LiquidationEngineParams } from "@repo/engine";
import type { Address, Hex } from "viem";
import { z } from "zod";

// The engine's domain params (addresses, ponder URL, redemption flags, tx
// timeout) are declared in `@repo/engine` and inherited here; this interface
// only adds the composition-root fields the service needs to wire the engine up.
export interface Config extends LiquidationEngineParams {
  // Signer for the bot's wallet client
  liquidatorPrivateKey: Hex;

  // RPC endpoint the bot's viem clients connect to
  rpcUrl: string;

  // Poll-loop interval
  pollingIntervalMs: number;

  // Metrics/health HTTP server port
  metricsPort: number;
}

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const envSchema = z.object({
  // Required
  LIQUIDATOR_PRIVATE_KEY: privateKeySchema,
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
    liquidatorPrivateKey: env.LIQUIDATOR_PRIVATE_KEY as Hex,
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
  };
}
