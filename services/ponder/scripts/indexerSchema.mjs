// Prints the Postgres schema for `ponder start`: DATABASE_SCHEMA when it is set, else a derived name.
//
// `ponder start` refuses a schema that a different build wrote ("Schema 'x' was previously used by
// a different Ponder app"). Ponder's build ID hashes ponder.config.ts's contracts (ABIs, addresses,
// start blocks), ponder.schema.ts and the indexing source. So the name below hashes the same
// inputs: the indexer source, the workspace packages it imports, the Ponder version and the env
// values that feed `contracts`. A change to any of them gives a new schema, and the indexer
// re-syncs into it. The previous schema stays, so a rollback resumes from its own checkpoint.
//
// The hash may change where Ponder's build ID does not (a README edit, CHAIN_ID). That costs a
// re-sync. The opposite case is the failure, so every input to Ponder's build ID must be here.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The env values that ponder.config.ts reads into `contracts`, plus the chain. */
export const SCHEMA_ENV_KEYS = [
  "CHAIN_ID",
  "START_BLOCK",
  "SPOKE_ADDRESS",
  "ADAPTER_ADDRESS",
  "VAULT_SWAP_ADDRESS",
];

/**
 * @param {{ sources: Array<{ path: string, contents: string | Buffer }>, ponderVersion: string,
 *   env: Record<string, string | undefined> }} input
 */
export function indexerSchema({ sources, ponderVersion, env }) {
  const hash = createHash("sha256");
  hash.update(`ponder ${ponderVersion}\0`);
  for (const key of SCHEMA_ENV_KEYS) hash.update(`${key}=${env[key] ?? ""}\0`);
  for (const { path, contents } of [...sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${path}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return `ponder_${hash.digest("hex").slice(0, 12)}`;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Ponder hashes every file under src/ with these extensions, tests included.
const isModule = (path) => /\.(js|mjs|ts|mts)$/.test(path);
// The packages reach the build ID only through what the indexer imports, so skip their tests.
export const isPackageSource = (path) => isModule(path) && !/\.(test|spec)\.[cm]?[jt]s$/.test(path);

/** Reads the indexer source and its @repo/* workspace packages, relative to services/ponder. */
export function readSources(ponderDir) {
  const pkg = JSON.parse(readFileSync(join(ponderDir, "package.json"), "utf8"));
  const packageDirs = Object.keys(pkg.dependencies ?? {})
    .filter((dep) => dep.startsWith("@repo/"))
    .map((dep) => join(ponderDir, "../../packages", dep.slice(6), "src"));
  const files = [
    join(ponderDir, "ponder.config.ts"),
    join(ponderDir, "ponder.schema.ts"),
    ...walk(join(ponderDir, "src")).filter(isModule),
    ...packageDirs.flatMap(walk).filter(isPackageSource),
  ];
  return files.map((path) => ({ path: relative(ponderDir, path), contents: readFileSync(path) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ponderDir = resolve(fileURLToPath(import.meta.url), "../..");
  // ponder's `exports` hides its package.json, so read it by path.
  const ponderPackage = realpathSync(join(ponderDir, "node_modules/ponder/package.json"));
  const ponderVersion = JSON.parse(readFileSync(ponderPackage, "utf8")).version;
  // Ponder loads .env.local from its working directory and lets the process env win. Read the
  // same file the same way, so the hash sees the addresses that Ponder sees.
  const dotenv = createRequire(ponderPackage)("dotenv");
  const envFile = join(ponderDir, ".env.local");
  const env = {
    ...(existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}),
    ...process.env,
  };
  if (env.DATABASE_SCHEMA) {
    console.log(env.DATABASE_SCHEMA);
  } else {
    const schema = indexerSchema({ sources: readSources(ponderDir), ponderVersion, env });
    console.error(`DATABASE_SCHEMA unset: using derived schema '${schema}'`);
    console.log(schema);
  }
}
