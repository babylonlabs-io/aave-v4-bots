import { createLogger } from "@repo/logger";
import { z } from "zod";

const logger = createLogger();

// Shared, validated env-var field schemas + a fail-fast parser. Each service
// composes these into its own env schema. Schemas validate the raw string env
// value; clients coerce to number/Hex/etc.
//
// The integer schemas come in two families, split by what the value *becomes*. `*IntSchema` is for
// anything that ends up in a JS `number` and is bounded at `MAX_SAFE_INTEGER`; `*BigIntSchema` is
// for `bigint` destinations, where digits past that point are ordinary rather than a mistake. See
// `fitsInNumber` for why the distinction is a safety property and not a nicety.

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

/** Rejects truncatable inputs like "1abc" or "1.5" that `Number.parseInt` would silently accept,
 * and anything signed — a leading `-` never reaches the numeric checks below. */
const DIGITS = /^\d+$/;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const NOT_SAFE = `must be at most ${Number.MAX_SAFE_INTEGER}: a larger value does not survive as a JS number — it rounds, or becomes Infinity`;

/**
 * Does this digit string survive the trip into a JS `number` unchanged?
 *
 * Compared as `BigInt`, because what it detects is exactly what `Number.parseInt` does to a value
 * it cannot hold: a few hundred digits become `Infinity`, and anything past `MAX_SAFE_INTEGER`
 * rounds silently — "9007199254740993" parses to ...992. Either way the process runs on a number
 * nobody configured, and where that number is a timeout, an interval, or a nonce fence, `Infinity`
 * does not mean "a long time", it means "never": the guard is off and nothing downstream says so.
 *
 * Non-digit input passes here so that the `DIGITS` regex is the only thing that reports it.
 */
const fitsInNumber = (v: string) => !DIGITS.test(v) || BigInt(v) <= MAX_SAFE;

/** A string that parses to an integer > 0, small enough to be a JS `number`. */
export const positiveIntSchema = z
  .string()
  .regex(DIGITS, "must be a valid integer")
  .refine(fitsInNumber, NOT_SAFE)
  .refine((v) => Number.parseInt(v, 10) > 0, "must be a positive integer");

/** A string that parses to an integer >= 0, small enough to be a JS `number`. */
export const nonNegativeIntSchema = z
  .string()
  .regex(DIGITS, "must be a valid integer")
  .refine(fitsInNumber, NOT_SAFE);

/**
 * A string that parses to an integer in `[min, max]` — for a quantity whose range is a fact about
 * the world (a TCP port) or about the protocol (a relay's retry window, in blocks).
 *
 * Worth stating wherever the *large* direction is the dangerous one and does not announce itself. A
 * fence in blocks or a deadline in milliseconds is still a perfectly good `number` at 10^15; it
 * simply never expires, and nothing downstream can tell that from a deliberately patient operator.
 */
export const intInRangeSchema = (min: number, max: number, hint?: string) =>
  z
    .string()
    .regex(DIGITS, "must be a valid integer")
    .refine(
      (v) => {
        if (!fitsInNumber(v)) return false;
        const n = Number.parseInt(v, 10);
        return n >= min && n <= max;
      },
      `must be an integer between ${min} and ${max}${hint ? ` — ${hint}` : ""}`
    );

/** A TCP port a server may bind. */
export const portSchema = intInRangeSchema(1, 65535);

/**
 * A string that parses to a `bigint` > 0 — for values whose destination is a `bigint` and which are
 * therefore *meant* to run past `MAX_SAFE_INTEGER`: any wei amount above ~0.009 ETH already does.
 * A value that ends up in a JS `number` belongs in `positiveIntSchema` instead.
 */
export const positiveBigIntSchema = z
  .string()
  .regex(DIGITS, "must be a valid integer")
  .refine((v) => !DIGITS.test(v) || BigInt(v) > 0n, "must be a positive integer");

/** A string that parses to a `bigint` >= 0 (see `positiveBigIntSchema` on why it has no ceiling). */
export const nonNegativeBigIntSchema = z.string().regex(DIGITS, "must be a valid integer");

/**
 * A string that parses to a proportion in basis points — an integer in [0, 10000].
 *
 * Bounded at both ends because the values are used as `x * bps / 10_000`, where a figure above
 * 10000 stops being a proportion: on a slippage ceiling it inflates the spend the bot will
 * authorize without limit, and on a profit floor it underflows to zero. Both directions are the
 * *permissive* one, and neither shows up as a wrong number anywhere — the transaction is simply
 * signed against a bound nobody meant.
 */
export const bpsSchema = intInRangeSchema(0, 10_000, "basis points, not a multiplier");

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
