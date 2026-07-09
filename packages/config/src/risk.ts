import type { RiskConfig } from "@repo/risk";
import { z } from "zod";

import { addressSchema, nonNegativeIntSchema, positiveIntSchema } from "./schemas";

// Env → `RiskConfig`, shared by every bot service so the risk knobs are spelled the same way
// everywhere. Every field is optional and **absent by default**: an unconfigured deployment gets
// the permissive gate it has today (never blocks, never auto-halts), and each variable set turns
// exactly one guard on.

/** `0x` + 64 hex chars — a keccak256 digest. */
const codeHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte hash");

/**
 * `addr=hash,addr=hash` → `{ addr: hash }`. Used by the code-hash guard to pin the bytecode of
 * the contracts the bot calls; a mismatch halts the process.
 */
export const codeHashMapSchema = z
  .string()
  .transform((raw, ctx) => {
    const entries: Array<[string, string]> = [];
    for (const pair of raw.split(",").map((p) => p.trim())) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${pair}" must be address=hash` });
        return z.NEVER;
      }
      entries.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
    }
    return Object.fromEntries(entries);
  })
  .pipe(z.record(addressSchema, codeHashSchema));

/**
 * The risk env fields, to be spread into a service's env schema:
 * `z.object({ ...riskEnvFields, PONDER_URL: urlSchema })`.
 */
export const riskEnvFields = {
  /** Auto-halt after this many consecutive failed actions. */
  RISK_MAX_CONSECUTIVE_FAILURES: positiveIntSchema.optional(),
  /** Profit floor in 8-decimal sats. `0` blocks only strictly-negative expected profit. */
  RISK_MIN_PROFIT: nonNegativeIntSchema.optional(),
  /** Block actions whose source data is older than this. */
  RISK_MAX_DATA_STALENESS_MS: positiveIntSchema.optional(),
  /** Exposure cap: max actions in flight at once. */
  RISK_MAX_IN_FLIGHT: positiveIntSchema.optional(),
  /**
   * Boot into HALTED — an operator must POST /resume before the bot trades. Strictly
   * `true`/`false`: a safety switch must not fail open on `True` or `1`, so anything else is a
   * config error rather than a silent "keep trading".
   */
  RISK_START_HALTED: z.enum(["true", "false"]).optional(),
  /** Pinned bytecode: `0xAdapter=0xhash,0xVaultSwap=0xhash`. */
  RISK_EXPECTED_CODE_HASHES: codeHashMapSchema.optional(),
  /** How often to re-verify the pinned bytecode. Ignored when no hashes are pinned. */
  RISK_CODE_CHECK_INTERVAL_MS: positiveIntSchema.optional().default("300000"),
  /**
   * Secret *reference* (e.g. an env-var name or AWS secret id) for the control endpoint's bearer
   * token, resolved via `@repo/secrets` at boot. Unset ⇒ no kill-switch endpoint is mounted.
   */
  RISK_CONTROL_TOKEN_REF: z.string().min(1).optional(),
} as const;

/** The env shape `buildRiskConfig` consumes — whatever `parseEnv(riskEnvFields ∪ …)` produces. */
export interface RiskEnv {
  RISK_MAX_CONSECUTIVE_FAILURES?: string;
  RISK_MIN_PROFIT?: string;
  RISK_MAX_DATA_STALENESS_MS?: string;
  RISK_MAX_IN_FLIGHT?: string;
  RISK_START_HALTED?: string;
  RISK_EXPECTED_CODE_HASHES?: Record<string, string>;
  RISK_CODE_CHECK_INTERVAL_MS: string;
  RISK_CONTROL_TOKEN_REF?: string;
}

/** The risk slice of a service `Config`. */
export interface RiskSettings {
  /** Passed straight to `createRiskGate`. */
  risk: RiskConfig;
  /** Interval for the periodic `verifyCode` re-check. */
  codeCheckIntervalMs: number;
  /** Secret ref for the control endpoint's bearer token; unset ⇒ endpoint not mounted. */
  controlTokenRef?: string;
}

const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));

/** Project parsed env onto the risk config. Absent vars stay absent (guard off). */
export function buildRiskConfig(env: RiskEnv): RiskSettings {
  return {
    risk: {
      maxConsecutiveFailures: int(env.RISK_MAX_CONSECUTIVE_FAILURES),
      minProfit: env.RISK_MIN_PROFIT === undefined ? undefined : BigInt(env.RISK_MIN_PROFIT),
      maxDataStalenessMs: int(env.RISK_MAX_DATA_STALENESS_MS),
      maxInFlight: int(env.RISK_MAX_IN_FLIGHT),
      expectedCodeHashes: env.RISK_EXPECTED_CODE_HASHES,
      startHalted: env.RISK_START_HALTED === "true",
    },
    codeCheckIntervalMs: Number.parseInt(env.RISK_CODE_CHECK_INTERVAL_MS, 10),
    controlTokenRef: env.RISK_CONTROL_TOKEN_REF,
  };
}
