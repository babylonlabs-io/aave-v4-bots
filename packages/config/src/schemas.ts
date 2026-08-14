import { createLogger } from "@repo/logger";
import { z } from "zod";

const logger = createLogger();

// Shared, validated env-var field schemas + a fail-fast parser. Each service
// composes these into its own env schema. Schemas validate the raw string env
// value; clients coerce to number/Hex/etc.

/** 0x + 40 hex chars (20-byte address). */
export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex address");

/** 0x + 64 hex chars (bytes32, e.g. a BTC redeem key). */
export const bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be 0x-prefixed 32-byte hex");

/** A valid URL. */
export const urlSchema = z.string().url("must be a valid URL");

/** A string that parses to an integer > 0. `/^\d+$/` rejects truncatable inputs
 * like "1abc" or "1.5" that `Number.parseInt` would silently accept. */
export const positiveIntSchema = z
  .string()
  .regex(/^\d+$/, "must be a valid integer")
  .refine((v) => Number.parseInt(v, 10) > 0, "must be a positive integer");

/** A string that parses to an integer >= 0 (see `positiveIntSchema` on the regex). */
export const nonNegativeIntSchema = z
  .string()
  .regex(/^\d+$/, "must be a valid integer")
  .refine((v) => Number.parseInt(v, 10) >= 0, "must be a non-negative integer");

/**
 * A string that parses to a proportion in basis points — an integer in [0, 10000].
 *
 * Bounded at both ends because the values are used as `x * bps / 10_000`, where a figure above
 * 10000 stops being a proportion: on a slippage ceiling it inflates the spend the bot will
 * authorize without limit, and on a profit floor it underflows to zero. Both directions are the
 * *permissive* one, and neither shows up as a wrong number anywhere — the transaction is simply
 * signed against a bound nobody meant.
 */
export const bpsSchema = z
  .string()
  .regex(/^\d+$/, "must be a valid integer")
  .refine(
    (v) => Number.parseInt(v, 10) <= 10_000,
    "must be at most 10000 (100%) — basis points, not a multiplier"
  );

/**
 * Comma-separated list of addresses → `string[]`. Empty entries are dropped; an
 * empty list parses to `[]`. Each remaining entry must be a valid address.
 */
export const addressListSchema = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
  )
  .pipe(z.array(addressSchema));

/**
 * Parse `env` against `schema`, **failing fast**: on any error, print each issue
 * and `process.exit(1)`. Returns the validated, typed data on success.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env
): z.infer<T> {
  // Treat an empty-string env var as unset, so `.optional().default(...)` applies
  // (matches the conventional `process.env.X || default` behavior).
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);

  if (!result.success) {
    logger.error("Configuration validation failed:");
    logger.error("");
    for (const error of result.error.errors) {
      logger.error(`  ✗ ${error.path.join(".")}: ${error.message}`);
    }
    logger.error("");
    logger.error("Please check your .env file and ensure all required variables are set.");
    process.exit(1);
  }

  return result.data;
}
