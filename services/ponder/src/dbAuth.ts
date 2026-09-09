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
// which is why both are refused below. NODE_TLS_REJECT_UNAUTHORIZED=0 is refused for the same
// reason: pg-connection-string turns sslmode=verify-full into `ssl = { ca }` and leaves
// `rejectUnauthorized` unset, so Node takes the value from that environment variable and the
// server certificate goes unchecked.

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
 * to it), a port the environment cannot move (the token is signed for one), TLS with server
 * verification (the token is a bearer credential) against a CA file that exists in this container.
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
  // A URL without a port parses to port = "", and node-postgres resolves the
  // port as `config.port || PGPORT || 5432`, so PGPORT would move the
  // connection away from the port the token is signed for. The host and the
  // user cannot drift the same way: both are non-empty here, so they win over
  // PGHOST and PGUSER.
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
  databaseUrl: string | undefined,
  options: InstallOptions = {}
): Promise<DbAuthMode> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const mode = parseDbAuthMode(env.DB_AUTH);
  if (mode !== "iam") return mode;

  // Without a URL Ponder falls back to local storage. In iam mode that would
  // silently drop the shared database the operator asked for, so refuse.
  if (!databaseUrl) {
    throw new Error(
      "DB_AUTH=iam: DATABASE_URL is not set (neither in the environment nor in the resolved secret); iam mode needs the shared Postgres, refusing to start on local storage"
    );
  }

  if (env.PGPASSWORD !== undefined) {
    throw new Error("DB_AUTH=iam: PGPASSWORD is set; it would override the IAM token, unset it");
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "DB_AUTH=iam: NODE_TLS_REJECT_UNAUTHORIZED=0 is set; it turns off the certificate check that sslmode=verify-full asks for and would send the IAM token to an unverified server, unset it"
    );
  }
  const target = iamTargetFromUrl(databaseUrl, env);
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
