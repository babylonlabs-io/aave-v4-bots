// RDS IAM database authentication for any process that opens Postgres connections.
// With DB_AUTH=iam the DATABASE_URL carries no password: each new connection presents a
// 15-minute token signed with the process's AWS credentials (on EKS, the IRSA role).
// This module validates the URL and environment and mints tokens; each caller hands the token
// to its own `pg` instance.

import fs from "node:fs";

export type DbAuthMode = "password" | "iam";

export interface IamTarget {
  hostname: string;
  port: number;
  username: string;
  region?: string;
}

export interface TokenSigner {
  getAuthToken(): Promise<string>;
}

export type SignerFactory = (target: IamTarget) => TokenSigner | Promise<TokenSigner>;

// Query parameters that can replace the URL's own authority or TLS switch. A config built by
// spreading a parsed URL lets `connectionString` replace the whole URL.
const OVERRIDING_QUERY_KEYS = new Set([
  "user",
  "password",
  "host",
  "port",
  "ssl",
  "connectionString",
]);

export function parseDbAuthMode(raw: string | undefined): DbAuthMode {
  if (raw === undefined || raw === "" || raw === "password") return "password";
  if (raw === "iam") return "iam";
  // The rejected value is not echoed: a misplaced secret would land in the logs.
  throw new Error('DB_AUTH must be "password" or "iam"');
}

/** Refuses `PGPASSWORD` (overrides the token) and `NODE_TLS_REJECT_UNAUTHORIZED=0` (skips TLS). */
export function assertIamEnvironment(env: Record<string, string | undefined> = process.env): void {
  if (env.PGPASSWORD !== undefined) {
    throw new Error("DB_AUTH=iam: PGPASSWORD is set; it would override the IAM token, unset it");
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "DB_AUTH=iam: NODE_TLS_REJECT_UNAUTHORIZED=0 is set; it turns off the certificate check that sslmode=verify-full asks for and would send the IAM token to an unverified server, unset it"
    );
  }
}

/**
 * The token signer's target, from DATABASE_URL. Refuses a URL with a password, without a user,
 * with a port the environment can move, or without verified TLS against a CA file on disk.
 */
export function iamTargetFromUrl(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env
): IamTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DB_AUTH=iam: DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DB_AUTH=iam: DATABASE_URL must use the postgresql:// scheme");
  }
  if (url.password !== "") {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL carries a password; a password in the URL overrides the IAM token, remove it"
    );
  }
  if (!url.username) {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL has no user; the token is issued for one database user"
    );
  }
  if (!url.hostname) {
    throw new Error("DB_AUTH=iam: DATABASE_URL has no host");
  }
  if (url.pathname.length <= 1) {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL has no database name; the driver would fall back to PGDATABASE or the user name, put the database in the URL"
    );
  }
  // The driver keeps the last duplicate, while URLSearchParams.get() returns the first, so a
  // repeated key could pass a check below with one value and connect with another.
  const seenKeys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seenKeys.has(key)) {
      throw new Error(
        `DB_AUTH=iam: DATABASE_URL repeats the query parameter "${key}"; the driver keeps the last value, remove the duplicate`
      );
    }
    seenKeys.add(key);
    if (OVERRIDING_QUERY_KEYS.has(key)) {
      throw new Error(
        `DB_AUTH=iam: DATABASE_URL must not carry "${key}" as a query parameter; the driver would let it replace the URL's own value`
      );
    }
  }
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode !== "verify-full") {
    throw new Error(
      `DB_AUTH=iam: DATABASE_URL must set sslmode=verify-full (got ${sslmode ?? "none"}); an IAM token is a bearer credential and must only reach the verified server`
    );
  }
  const sslrootcert = url.searchParams.get("sslrootcert");
  if (!sslrootcert) {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL must set sslrootcert=<RDS CA bundle>; Node's default trust store does not contain the RDS certificate authority"
    );
  }
  if (!fs.existsSync(sslrootcert)) {
    throw new Error(`DB_AUTH=iam: sslrootcert file not found: ${sslrootcert}`);
  }
  // Without a port in the URL the driver falls back to PGPORT, but the token is signed for one port.
  if (!url.port && env.PGPORT !== undefined) {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL has no port and PGPORT is set; the driver would connect to the PGPORT port while the token is signed for another, put the port in the URL"
    );
  }
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    username: decodeURIComponent(url.username),
  };
}

/** The signer's region. Empty or unset defers to the AWS SDK's own region resolution. */
export function awsRegionFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
}

async function defaultSignerFactory(target: IamTarget): Promise<TokenSigner> {
  // Loaded lazily so the AWS SDK never loads in password mode.
  const { Signer } = await import("@aws-sdk/rds-signer");
  return new Signer({
    hostname: target.hostname,
    port: target.port,
    username: target.username,
    region: target.region,
  });
}

/** Returns a function that mints a fresh token per call. The signer is built on the first call. */
export function createIamTokenSource(
  target: IamTarget,
  signerFactory: SignerFactory = defaultSignerFactory
): () => Promise<string> {
  let signer: Promise<TokenSigner> | undefined;
  return async () => {
    signer ??= Promise.resolve(signerFactory(target));
    return (await signer).getAuthToken();
  };
}
