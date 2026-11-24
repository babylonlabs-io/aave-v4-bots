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
import {
  type DbAuthMode,
  type SignerFactory,
  assertIamEnvironment,
  awsRegionFromEnv,
  createIamTokenSource,
  iamTargetFromUrl,
  parseDbAuthMode,
} from "@repo/db-auth";

export {
  type DbAuthMode,
  type IamTarget,
  type SignerFactory,
  type TokenSigner,
  iamTargetFromUrl,
  parseDbAuthMode,
} from "@repo/db-auth";

/** The subset of a `pg` module instance the hook touches. */
export interface PgLike {
  defaults: { password?: unknown };
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

  assertIamEnvironment(env);
  const target = { ...iamTargetFromUrl(databaseUrl, env), region: awsRegionFromEnv(env) };

  const getToken = createIamTokenSource(target, options.signerFactory);
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
