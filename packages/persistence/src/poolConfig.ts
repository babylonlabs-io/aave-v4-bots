import {
  type SignerFactory,
  assertIamEnvironment,
  awsRegionFromEnv,
  createIamTokenSource,
  iamTargetFromUrl,
} from "@repo/db-auth";
import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import type { PersistenceConfig } from "./types";

// The query parameters IAM mode carries into the pool config. Any other key would be dropped, so it
// is refused rather than silently ignored.
const IAM_QUERY_KEYS = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey", "application_name"]);

export interface PoolAuthOptions {
  env?: Record<string, string | undefined>;
  /** Replaces the RDS signer (tests). */
  signerFactory?: SignerFactory;
}

/**
 * The `pg.Pool` connection settings for a store. Password mode passes the URL through. IAM mode
 * validates it (see `@repo/db-auth`) and sets a per-connection token as the password.
 */
export function buildPoolConfig(
  config: PersistenceConfig,
  options: PoolAuthOptions = {}
): PoolConfig {
  if ((config.auth ?? "password") === "password") {
    return { connectionString: config.connectionString };
  }
  const env = options.env ?? process.env;
  assertIamEnvironment(env);
  const target = {
    ...iamTargetFromUrl(config.connectionString, env),
    region: awsRegionFromEnv(env),
  };
  // Parsed here, not passed as `connectionString`: pg merges the parsed URL over the pool config,
  // and a URL without a password would replace the token function with "". Only connection fields
  // are copied, so no other query parameter reaches pg or pg-pool.
  for (const key of new URL(config.connectionString).searchParams.keys()) {
    if (!IAM_QUERY_KEYS.has(key)) {
      throw new Error(
        `DB_AUTH=iam: DATABASE_URL query parameter "${key}" is not supported in iam mode; allowed: ${[...IAM_QUERY_KEYS].join(", ")}`
      );
    }
  }
  const parsed = parseIntoClientConfig(config.connectionString);
  const ssl = typeof parsed.ssl === "object" ? parsed.ssl : {};
  return {
    host: target.hostname,
    port: target.port,
    user: target.username,
    database: parsed.database,
    application_name: parsed.application_name,
    ssl: { ...ssl, rejectUnauthorized: true },
    password: createIamTokenSource(target, options.signerFactory),
  };
}
