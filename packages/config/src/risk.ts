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
  /** Port for the kill-switch server. Separate from METRICS_PORT, which is scrapeable. */
  RISK_CONTROL_PORT: positiveIntSchema.optional().default("9095"),
  /**
   * Interface the kill-switch server binds. Loopback by default: an endpoint that can stop
   * production trading should not be reachable off-box unless you say so.
   */
  RISK_CONTROL_HOST: z.string().min(1).optional().default("127.0.0.1"),
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
  RISK_CONTROL_PORT: string;
  RISK_CONTROL_HOST: string;
}

/** The risk slice of a service `Config`. */
export interface RiskSettings {
  /** Passed straight to `createRiskGate`. */
  risk: RiskConfig;
  /** Interval for the periodic `verifyCode` re-check. */
  codeCheckIntervalMs: number;
  /** Secret ref for the control endpoint's bearer token; unset ⇒ endpoint not mounted. */
  controlTokenRef?: string;
  /** Where the kill-switch server listens. Its own socket, loopback by default. */
  controlPort: number;
  controlHost: string;
}

const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));

/**
 * Project parsed env onto the risk config. Absent vars stay absent (guard off).
 *
 * Throws on a config that would boot a bot nobody can start: `RISK_START_HALTED=true` halts on
 * *every* boot, so unlike a breaker trip or a boot-probe halt (both cleared by a restart) it has
 * no recovery path unless the kill-switch endpoint is mounted to serve `POST /resume`.
 */
export function buildRiskConfig(env: RiskEnv): RiskSettings {
  const startHalted = env.RISK_START_HALTED === "true";
  if (startHalted && !env.RISK_CONTROL_TOKEN_REF) {
    throw new Error(
      "RISK_START_HALTED=true requires RISK_CONTROL_TOKEN_REF: without the kill-switch endpoint " +
        "the bot boots HALTED on every restart and can never be resumed."
    );
  }

  return {
    risk: {
      maxConsecutiveFailures: int(env.RISK_MAX_CONSECUTIVE_FAILURES),
      minProfit: env.RISK_MIN_PROFIT === undefined ? undefined : BigInt(env.RISK_MIN_PROFIT),
      maxDataStalenessMs: int(env.RISK_MAX_DATA_STALENESS_MS),
      maxInFlight: int(env.RISK_MAX_IN_FLIGHT),
      expectedCodeHashes: env.RISK_EXPECTED_CODE_HASHES,
      startHalted,
    },
    codeCheckIntervalMs: Number.parseInt(env.RISK_CODE_CHECK_INTERVAL_MS, 10),
    controlTokenRef: env.RISK_CONTROL_TOKEN_REF,
    controlPort: Number.parseInt(env.RISK_CONTROL_PORT, 10),
    controlHost: env.RISK_CONTROL_HOST,
  };
}

/**
 * Reject a profit floor this process cannot actually enforce.
 *
 * `minProfit` only bites where an engine hands the gate an `expectedProfit`. The arbitrage engine
 * does (exactly, from `previewEscrowedVaults`); the **liquidation** engine cannot — liquidation
 * profit is not derivable off-chain today, because the Lens returns per-reserve debt in debt-token
 * units and the adapter returns only vault ids, so neither the estimate nor the simulation yields a
 * WBTC-denominated figure.
 *
 * This guard is **interim by design**. Closing the gap properly needs a contracts change — either a
 * Lens view that returns a WBTC-denominated profit, or the on-chain profit revert that comes with a
 * liquidation router — so it is deferred to the contracts work. When either lands, the liquidation
 * engine can pass a real `expectedProfit` to `openSlot` and this function goes away.
 *
 * Left alone that is a *silent* hole: an operator sets `RISK_MIN_PROFIT`, boot succeeds, and every
 * liquidation goes out ungated while the floor looks enabled. Refusing the combination turns it
 * into an explicit choice at boot. Deliberately an error rather than a warning — a log line about
 * a risk control that isn't actually running is precisely what scrolls past unread.
 *
 * @param hasLiquidationEngine whether this process runs the liquidation engine — always true for
 *   the liquidator; for the arbitrageur only when `ADAPTER_ADDRESS` + `LENS_ADDRESS` opt it in.
 */
export function assertProfitFloorEnforceable(
  settings: RiskSettings,
  hasLiquidationEngine: boolean
): void {
  if (settings.risk.minProfit === undefined || !hasLiquidationEngine) return;
  throw new Error(
    "RISK_MIN_PROFIT is set but this process runs the liquidation engine, which cannot supply an " +
      "expected profit — the floor would apply to arbitrage only and leave every liquidation " +
      "ungated. Unset RISK_MIN_PROFIT, or run without the liquidation engine (arbitrageur: unset " +
      "ADAPTER_ADDRESS + LENS_ADDRESS)."
  );
}
