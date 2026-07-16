import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { z } from "zod";

import { addressSchema, nonNegativeIntSchema } from "./schemas";

/** A 0x-prefixed address. `@repo/config` avoids a `viem` dependency, so it names the shape itself. */
type Hex40 = `0x${string}`;

// Env fields every bot service shares: where secrets come from, how the signer is obtained, and
// whether crash-safety persistence is on. Declared once so the two services cannot drift.
//
// The **signer** projection deliberately stays in each service: `buildSignerConfig` is a value
// import from `@repo/signer`, and pulling it in here would give every `@repo/config` consumer a
// runtime dependency on the AWS KMS SDK.
//
// Everything this module imports from a sibling package is `import type`, erased at compile time,
// so `@repo/{persistence,secrets,risk}` are **devDependencies** of `@repo/config`: they name the
// shapes these builders return without putting those packages in any consumer's runtime graph.

export const runtimeEnvFields = {
  // Signer + secrets source selection. Defaults preserve today's behavior: a local signer whose
  // key is read from the service's own `*_PRIVATE_KEY` env var.
  SECRETS_PROVIDER: z.enum(["env", "aws"]).optional().default("env"),
  SIGNER_SOURCE: z.enum(["local", "aws"]).optional().default("local"),
  /** Where the key lives — an env-var name, or an AWS secret id. Never the key itself. */
  SIGNER_KEY_REF: z.string().min(1).optional(),
  KMS_KEY_ID: z.string().min(1).optional(),
  SIGNER_ADDRESS: addressSchema.optional(),
  AWS_REGION: z.string().min(1).optional(),

  /** Enables the Postgres StateStore. Unset ⇒ no persistence (in-memory nonce sequencing). */
  DATABASE_URL: z.string().min(1).optional(),
  /** Isolates the bot's tables from the indexer's. */
  PERSISTENCE_SCHEMA: z.string().min(1).optional(),

  /** Outbound alerts. `none` (default) logs only; `slack` also posts to a webhook. */
  NOTIFIER: z.enum(["none", "slack"]).optional().default("none"),
  /**
   * Secret *reference* for the Slack webhook URL — an env-var name or an AWS secret id, never the
   * URL itself. Resolved through `@repo/secrets` at boot, like `SIGNER_KEY_REF`. Required when
   * `NOTIFIER=slack`.
   */
  SLACK_WEBHOOK_REF: z.string().min(1).optional(),

  /**
   * How the service executes. `AUTO` (default) signs + broadcasts (the bot holds the key).
   * `MANUAL` is **keyless**: it persists a content-hashed proposal + notifies an operator who
   * signs with their own wallet — no private key, `WalletClient`, or nonce anywhere in the process.
   */
  EXECUTION_MODE: z.enum(["AUTO", "MANUAL"]).optional().default("AUTO"),
  /**
   * The EOA that will broadcast the proposals — the identity whose balances/allowances the engine
   * reads and whose `from` its simulations use. An address, never a key. Required in MANUAL.
   */
  MANUAL_EXECUTOR_ADDRESS: addressSchema.optional(),
  /**
   * How long (ms) an un-actioned MANUAL proposal lives before it's swept to `expired` — freeing its
   * subject to be re-proposed (and re-notified). `0` disables expiry. Default 3 hours. MANUAL only.
   */
  MANUAL_INTENT_TTL_MS: nonNegativeIntSchema.optional().default("10800000"),
} as const;

/** The env shape the builders below consume. */
export interface RuntimeEnv {
  SECRETS_PROVIDER: "env" | "aws";
  AWS_REGION?: string;
  DATABASE_URL?: string;
  PERSISTENCE_SCHEMA?: string;
  NOTIFIER: "none" | "slack";
  SLACK_WEBHOOK_REF?: string;
}

/**
 * The env subset `buildExecutionConfig` reads. Kept separate from `RuntimeEnv` so the mode's
 * cross-field validation (it inspects the signer + persistence vars) doesn't force every other
 * builder's callers to supply signer fields.
 */
export interface ExecutionEnv {
  EXECUTION_MODE: "AUTO" | "MANUAL";
  // Address vars stay `string` here — the `addressSchema` regex validates the format but zod infers
  // `string`; `buildExecutionConfig` narrows to `Hex40` on the way out.
  MANUAL_EXECUTOR_ADDRESS?: string;
  MANUAL_INTENT_TTL_MS: string;
  DATABASE_URL?: string;
  SIGNER_SOURCE: "local" | "aws";
  SIGNER_KEY_REF?: string;
  KMS_KEY_ID?: string;
  SIGNER_ADDRESS?: string;
}

/**
 * How a service executes. A discriminated union so MANUAL *carries* its broadcasting address (and
 * proposal TTL) — the composition root reads them without a re-check, and AUTO simply has no
 * key-shaped fields.
 */
export type ExecutionSettings =
  | { mode: "AUTO" }
  | {
      mode: "MANUAL";
      /** The EOA whose balances/allowances the engine reads and whose `from` it simulates from. */
      manualExecutorAddress: Hex40;
      /** Sweep an un-actioned proposal to `expired` after this many ms (`0` disables). */
      intentTtlMs: number;
    };

/** How a service selects and resolves its notifier — the source, plus the secret ref to resolve. */
export interface NotifierSettings {
  source: "none" | "slack";
  /** Secret reference for the webhook URL (only for `slack`); resolve via `@repo/secrets`. */
  webhookRef?: string;
}

/**
 * Project the notifier env into a service's boot plan. Rejects `slack` with no webhook ref here —
 * at config time — rather than letting the notifier factory fail later, so a misconfigured alerting
 * setup stops the bot at startup instead of at the first alert it fails to send.
 */
export function buildNotifierConfig(env: RuntimeEnv): NotifierSettings {
  if (env.NOTIFIER === "slack" && !env.SLACK_WEBHOOK_REF) {
    throw new Error("NOTIFIER=slack requires SLACK_WEBHOOK_REF (a secret reference)");
  }
  return { source: env.NOTIFIER, webhookRef: env.SLACK_WEBHOOK_REF };
}

/** Where secrets are resolved from. The key material itself never appears in `Config`. */
export function buildSecretsConfig(env: RuntimeEnv): SecretsConfig {
  return { source: env.SECRETS_PROVIDER, region: env.AWS_REGION };
}

/** Crash-safety persistence, present iff `DATABASE_URL` is set. */
export function buildPersistenceConfig(env: RuntimeEnv): PersistenceConfig | undefined {
  if (!env.DATABASE_URL) return undefined;
  return { connectionString: env.DATABASE_URL, schema: env.PERSISTENCE_SCHEMA };
}

/**
 * Project the execution-mode env into a service's boot plan, failing fast on a MANUAL setup that
 * cannot honor its own contract. MANUAL is keyless and durable, so it **requires** the broadcasting
 * address and a `StateStore`, and it **must not** carry a signing key — a MANUAL bot that resolved
 * one would break the property the mode exists for (no hot key to steal). AUTO is unchanged.
 *
 * `opts.signerKeyPresent` is whether the service's signing-key env var actually holds a value (the
 * service knows its own key-ref name, e.g. `LIQUIDATOR_PRIVATE_KEY`, so it computes this and passes
 * it in). It closes the gap the schema-field checks below cannot see: a MANUAL deployment that never
 * sets an explicit signer var but leaves the raw key in the process env — which a compromised MANUAL
 * process could still read and exfiltrate, defeating "no hot key to steal".
 */
export function buildExecutionConfig(
  env: ExecutionEnv,
  opts: { signerKeyPresent?: boolean } = {}
): ExecutionSettings {
  if (env.EXECUTION_MODE === "AUTO") {
    return { mode: "AUTO" };
  }

  if (!env.MANUAL_EXECUTOR_ADDRESS) {
    throw new Error(
      "EXECUTION_MODE=MANUAL requires MANUAL_EXECUTOR_ADDRESS (the EOA that will broadcast)"
    );
  }
  if (!env.DATABASE_URL) {
    throw new Error("EXECUTION_MODE=MANUAL requires DATABASE_URL — proposals must be persisted");
  }
  // We promised a MANUAL process holds no key: reject an explicitly configured signer, AND the raw
  // key material sitting in the env, rather than silently ignore either — so a mis-set deployment
  // stops at boot instead of running with a live key it did not expect to. (The composition root
  // also never calls `resolveSigner` in MANUAL, so the key is never loaded into a signer object;
  // this is the defense-in-depth that keeps it out of the process env entirely.)
  const signerVars = [
    env.SIGNER_SOURCE === "aws" && "SIGNER_SOURCE=aws",
    env.SIGNER_KEY_REF && "SIGNER_KEY_REF",
    env.KMS_KEY_ID && "KMS_KEY_ID",
    env.SIGNER_ADDRESS && "SIGNER_ADDRESS",
    opts.signerKeyPresent && "the signing-key env var",
  ].filter((v): v is string => Boolean(v));
  if (signerVars.length > 0) {
    throw new Error(
      `EXECUTION_MODE=MANUAL is keyless and must hold no signing key — unset ${signerVars.join(", ")}`
    );
  }

  return {
    mode: "MANUAL",
    manualExecutorAddress: env.MANUAL_EXECUTOR_ADDRESS as Hex40,
    intentTtlMs: Number.parseInt(env.MANUAL_INTENT_TTL_MS, 10),
  };
}
