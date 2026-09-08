// IAM database authentication for the indexer's Postgres connections.
//
// With DB_AUTH=iam the DATABASE_URL carries no password. Each new connection presents a 15-minute
// RDS IAM token instead, signed locally with the process's AWS credentials (on EKS the
// ServiceAccount's IAM role, allowed rds-db:connect as exactly this database user). Nothing is
// stored: the token is minted when a connection opens and is useless after 15 minutes. Off by
// default, like every other opt-in here.
//
// The hook lives on `pg.defaults.password` rather than in Ponder's pool config because there is no
// other seam: node-postgres merges the parsed connection string over the pool config, and a URL
// without a password parses to password = "" which overwrites any function given alongside it. The
// driver then resolves the password as `url password || PGPASSWORD || pg.defaults.password` and
// accepts a function in defaults, called once per new connection. Ponder always passes a
// connection string and copies only `max` and `ssl` from poolConfig, so defaults are what its four
// pools see. This service declares no `pg` of its own, so the instance to hook is the one Ponder
// resolves, found from the real path of node_modules/ponder (Ponder's package exports carry no
// `require` condition and no `./package.json` subpath, so a bare specifier cannot anchor it).
// The same resolution rules make a password in the URL and a set PGPASSWORD override the hook,
// which is why both are refused below.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

/** The subset of a `pg` module instance the hook touches. */
export interface PgLike {
  defaults: { password?: unknown };
}

/**
 * Query parameters that pg-connection-string lets replace the URL's own
 * authority (user, password, host, port) or its TLS switch (ssl). In iam
 * mode each would let a URL that passes the checks below reach the driver as
 * something else, so they are refused.
 */
const OVERRIDING_QUERY_KEYS = new Set(["user", "password", "host", "port", "ssl"]);

export function parseDbAuthMode(raw: string | undefined): DbAuthMode {
  if (raw === undefined || raw === "" || raw === "password") return "password";
  if (raw === "iam") return "iam";
  throw new Error(`DB_AUTH must be "password" or "iam", got "${raw}"`);
}

/**
 * The connection target for the token signer, taken from DATABASE_URL, with the shape checks that
 * make the token path safe: no password (it would override the token), a user (the token is bound
 * to it), TLS with server verification (the token is a bearer credential) against a CA file that
 * exists in this container.
 */
export function iamTargetFromUrl(databaseUrl: string): IamTarget {
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
  // node-postgres hands the URL to pg-connection-string, which copies every
  // query parameter into the pool config in order (the last duplicate wins)
  // and lets user, password, host and port from the query replace the URL's
  // own. URLSearchParams.get() below returns the first value, so a repeated
  // key could pass this check with one value and reach the driver with
  // another (`...&sslmode=verify-full&sslmode=no-verify`), and a query
  // password would pass the URL check above and override the token. Refuse
  // both shapes outright.
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
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    username: decodeURIComponent(url.username),
  };
}

/**
 * The `pg` module instance Ponder resolves, anchored at the real path of node_modules/ponder so
 * pnpm's symlink layout cannot mislead the lookup. Null when Ponder is not installed under `cwd`.
 */
export function resolvePonderPg(cwd: string = process.cwd()): PgLike | null {
  try {
    const ponderDir = fs.realpathSync(path.join(cwd, "node_modules", "ponder"));
    const requireFromPonder = createRequire(path.join(ponderDir, "package.json"));
    return requireFromPonder("pg") as PgLike;
  } catch {
    return null;
  }
}

/** Install `getToken` as the default password of every distinct `pg` instance given. */
export function installPasswordHook(modules: PgLike[], getToken: () => Promise<string>): number {
  const seen = new Set<object>();
  for (const mod of modules) {
    if (seen.has(mod.defaults)) continue;
    seen.add(mod.defaults);
    mod.defaults.password = getToken;
  }
  return seen.size;
}

async function defaultSignerFactory(target: IamTarget): Promise<TokenSigner> {
  // Loaded lazily so the signer never enters the process in password mode.
  const { Signer } = await import("@aws-sdk/rds-signer");
  return new Signer({
    hostname: target.hostname,
    port: target.port,
    username: target.username,
    region: target.region,
  });
}

export interface InstallOptions {
  env?: Record<string, string | undefined>;
  signerFactory?: SignerFactory;
  /** Override the `pg` instances to hook (tests). Default: the one Ponder resolves. */
  pgModules?: PgLike[];
  log?: (line: string) => void;
}

/**
 * Read DB_AUTH and, in iam mode, wire the token hook. Runs once from ponder.config.ts, before any
 * pool exists. Mints one token immediately so a missing role, region or credential fails the boot
 * rather than the first query.
 */
export async function installDatabaseAuth(
  databaseUrl: string,
  options: InstallOptions = {}
): Promise<DbAuthMode> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const mode = parseDbAuthMode(env.DB_AUTH);
  if (mode !== "iam") return mode;

  if (env.PGPASSWORD !== undefined) {
    throw new Error("DB_AUTH=iam: PGPASSWORD is set; it would override the IAM token, unset it");
  }
  const target = iamTargetFromUrl(databaseUrl);
  target.region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;

  const signer = await (options.signerFactory ?? defaultSignerFactory)(target);
  const getToken = () => signer.getAuthToken();
  await getToken();

  let modules = options.pgModules;
  if (!modules) {
    const ponderPg = resolvePonderPg();
    if (!ponderPg) {
      throw new Error(
        "DB_AUTH=iam: ponder's pg module could not be resolved from node_modules/ponder, so no pool would carry the token hook"
      );
    }
    modules = [ponderPg];
  }
  const hooked = installPasswordHook(modules, getToken);
  log(
    JSON.stringify({
      event: "db_auth",
      mode: "iam",
      user: target.username,
      host: target.hostname,
      port: target.port,
      region: target.region ?? "sdk-default",
      pg_instances_hooked: hooked,
    })
  );
  return mode;
}
