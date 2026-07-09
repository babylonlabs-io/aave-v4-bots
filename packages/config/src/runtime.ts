import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { z } from "zod";

import { addressSchema } from "./schemas";

// Env fields every bot service shares: where secrets come from, how the signer is obtained, and
// whether crash-safety persistence is on. Declared once so the two services cannot drift.
//
// The **signer** projection deliberately stays in each service: `buildSignerConfig` is a value
// import from `@repo/signer`, and pulling it in here would give every `@repo/config` consumer a
// runtime dependency on the AWS KMS SDK. Everything below is a type-only import.

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
} as const;

/** The env shape the builders below consume. */
export interface RuntimeEnv {
  SECRETS_PROVIDER: "env" | "aws";
  AWS_REGION?: string;
  DATABASE_URL?: string;
  PERSISTENCE_SCHEMA?: string;
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
