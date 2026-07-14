import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { z } from "zod";

import { addressSchema } from "./schemas";

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
