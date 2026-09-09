import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type PgLike,
  type TokenSigner,
  iamTargetFromUrl,
  installDatabaseAuth,
  installPasswordHook,
  parseDbAuthMode,
  resolvePonderPg,
} from "../src/dbAuth";

const caFile = path.join(os.tmpdir(), `db-auth-test-ca-${process.pid}.pem`);
fs.writeFileSync(
  caFile,
  "-----BEGIN CERTIFICATE-----\nnot a real certificate\n-----END CERTIFICATE-----\n"
);
const goodUrl = `postgresql://liquidation_indexer@db.example.internal:5432/liquidation_ponder?sslmode=verify-full&sslrootcert=${caFile}`;

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The parser node-postgres runs on a connection string, resolved from the pg
 * instance Ponder loads so the positive control below exercises the same code
 * the pools do.
 */
function pgConnectionStringParse(): (s: string) => Record<string, unknown> {
  const ponderDir = fs.realpathSync(path.join(testRoot, "node_modules", "ponder"));
  const fromPonder = createRequire(path.join(ponderDir, "package.json"));
  const fromPg = createRequire(fromPonder.resolve("pg"));
  return (fromPg("pg-connection-string") as { parse: (s: string) => Record<string, unknown> })
    .parse;
}

function fakePg(): PgLike {
  return { defaults: {} };
}

function countingSigner(): TokenSigner & { calls: number } {
  const signer = {
    calls: 0,
    async getAuthToken() {
      signer.calls += 1;
      return `token-${signer.calls}`;
    },
  };
  return signer;
}

describe("parseDbAuthMode", () => {
  it("treats unset and password as password", () => {
    assert.equal(parseDbAuthMode(undefined), "password");
    assert.equal(parseDbAuthMode(""), "password");
    assert.equal(parseDbAuthMode("password"), "password");
  });

  it("accepts iam and nothing else", () => {
    assert.equal(parseDbAuthMode("iam"), "iam");
    assert.throws(() => parseDbAuthMode("IAM"), /DB_AUTH must be/);
    assert.throws(() => parseDbAuthMode("yes"), /DB_AUTH must be/);
  });
});

describe("iamTargetFromUrl", () => {
  it("extracts host, port and user from a password-less verify-full URL", () => {
    assert.deepEqual(iamTargetFromUrl(goodUrl), {
      hostname: "db.example.internal",
      port: 5432,
      username: "liquidation_indexer",
    });
  });

  it("defaults the port to 5432 and decodes the user", () => {
    const t = iamTargetFromUrl(
      `postgresql://a%5Fb@host/db?sslmode=verify-full&sslrootcert=${caFile}`
    );
    assert.equal(t.port, 5432);
    assert.equal(t.username, "a_b");
  });

  it("rejects a password in the URL, which would override the token", () => {
    assert.throws(
      () =>
        iamTargetFromUrl(`postgresql://u:secret@host/db?sslmode=verify-full&sslrootcert=${caFile}`),
      /carries a password/
    );
  });

  it("requires sslmode=verify-full", () => {
    assert.throws(
      () => iamTargetFromUrl(`postgresql://u@host/db?sslrootcert=${caFile}`),
      /sslmode=verify-full/
    );
    assert.throws(
      () => iamTargetFromUrl(`postgresql://u@host/db?sslmode=no-verify&sslrootcert=${caFile}`),
      /sslmode=verify-full/
    );
  });

  it("requires an existing sslrootcert file", () => {
    assert.throws(
      () => iamTargetFromUrl("postgresql://u@host/db?sslmode=verify-full"),
      /sslrootcert=/
    );
    assert.throws(
      () =>
        iamTargetFromUrl(
          "postgresql://u@host/db?sslmode=verify-full&sslrootcert=/nonexistent/ca.pem"
        ),
      /not found/
    );
  });

  it("requires a user and a valid URL", () => {
    assert.throws(
      () => iamTargetFromUrl(`postgresql://host/db?sslmode=verify-full&sslrootcert=${caFile}`),
      /no user/
    );
    assert.throws(() => iamTargetFromUrl("not a url"), /not a valid URL/);
  });
});

describe("installPasswordHook", () => {
  it("installs one hook per distinct defaults object", () => {
    const a = fakePg();
    const b = fakePg();
    const sameAsA: PgLike = { defaults: a.defaults };
    const getToken = async () => "t";
    assert.equal(installPasswordHook([a, b, sameAsA], getToken), 2);
    assert.equal(a.defaults.password, getToken);
    assert.equal(b.defaults.password, getToken);
  });
});

describe("installDatabaseAuth", () => {
  it("is a no-op in password mode and never touches the signer", async () => {
    const mod = fakePg();
    let factoryCalls = 0;
    const mode = await installDatabaseAuth(goodUrl, {
      env: { DB_AUTH: "password" },
      pgModules: [mod],
      signerFactory: () => {
        factoryCalls += 1;
        return countingSigner();
      },
      log: () => {},
    });
    assert.equal(mode, "password");
    assert.equal(factoryCalls, 0);
    assert.equal(mod.defaults.password, undefined);
  });

  it("mints a token at boot and installs a per-connection hook in iam mode", async () => {
    const mod = fakePg();
    const signer = countingSigner();
    const logs: string[] = [];
    const mode = await installDatabaseAuth(goodUrl, {
      env: { DB_AUTH: "iam", AWS_REGION: "ap-east-1" },
      pgModules: [mod],
      signerFactory: (target) => {
        assert.equal(target.username, "liquidation_indexer");
        assert.equal(target.region, "ap-east-1");
        return signer;
      },
      log: (line) => logs.push(line),
    });
    assert.equal(mode, "iam");
    assert.equal(signer.calls, 1, "one token minted at install, the boot-time check");
    const hook = mod.defaults.password as () => Promise<string>;
    assert.equal(typeof hook, "function");
    assert.equal(await hook(), "token-2");
    assert.equal(await hook(), "token-3", "a fresh token per call, i.e. per new connection");
    const entry = JSON.parse(logs.at(-1) ?? "{}");
    assert.equal(entry.event, "db_auth");
    assert.equal(entry.pg_instances_hooked, 1);
    assert.equal(entry.user, "liquidation_indexer");
  });

  it("refuses iam mode without a DATABASE_URL instead of falling back to local storage", async () => {
    await assert.rejects(
      installDatabaseAuth(undefined, {
        env: { DB_AUTH: "iam" },
        pgModules: [fakePg()],
        signerFactory: countingSigner,
        log: () => {},
      }),
      /DATABASE_URL is not set/
    );
  });

  it("is a no-op without a DATABASE_URL in password mode", async () => {
    const mod = fakePg();
    assert.equal(
      await installDatabaseAuth(undefined, { env: {}, pgModules: [mod], log: () => {} }),
      "password"
    );
    assert.equal(mod.defaults.password, undefined);
  });

  it("refuses PGPASSWORD alongside iam", async () => {
    await assert.rejects(
      installDatabaseAuth(goodUrl, {
        env: { DB_AUTH: "iam", PGPASSWORD: "x" },
        pgModules: [fakePg()],
        signerFactory: countingSigner,
        log: () => {},
      }),
      /PGPASSWORD is set/
    );
  });

  it("fails the boot when the signer cannot mint", async () => {
    await assert.rejects(
      installDatabaseAuth(goodUrl, {
        env: { DB_AUTH: "iam" },
        pgModules: [fakePg()],
        signerFactory: () => ({
          async getAuthToken() {
            throw new Error("no credentials");
          },
        }),
        log: () => {},
      }),
      /no credentials/
    );
  });
});

describe("resolvePonderPg", () => {
  it("reaches the pg instance that Ponder itself imports", () => {
    // This service declares no pg of its own; the hook must land on the copy Ponder resolves.
    // Compare against a require anchored at ponder's real package directory, the same route the
    // resolver takes, so a pnpm layout change that breaks the route fails here first.
    const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ponderPg = resolvePonderPg(serviceRoot);
    assert.ok(ponderPg, "ponder's pg instance resolved");
    const ponderDir = fs.realpathSync(path.join(serviceRoot, "node_modules", "ponder"));
    const expected = createRequire(path.join(ponderDir, "package.json"))("pg") as PgLike;
    assert.equal(ponderPg?.defaults, expected.defaults);
    assert.equal(typeof ponderPg?.defaults, "object");
  });
});

describe("iamTargetFromUrl query parameters", () => {
  it("refuses a repeated query parameter (the driver keeps the last value)", () => {
    assert.throws(
      () => iamTargetFromUrl(`${goodUrl}&sslmode=no-verify`),
      /repeats the query parameter "sslmode"/
    );
    assert.throws(
      () => iamTargetFromUrl(`${goodUrl}&sslmode=disable`),
      /repeats the query parameter "sslmode"/
    );
    assert.throws(
      () => iamTargetFromUrl(`${goodUrl}&sslrootcert=/other/ca.pem`),
      /repeats the query parameter "sslrootcert"/
    );
  });

  it("refuses user, password, host, port and ssl as query parameters", () => {
    for (const extra of [
      "password=secret",
      "user=postgres",
      "host=other.example",
      "port=1",
      "ssl=0",
    ]) {
      assert.throws(() => iamTargetFromUrl(`${goodUrl}&${extra}`), /must not carry/, extra);
    }
  });

  it("positive control: pg-connection-string keeps the last duplicate and a query password", () => {
    const parse = pgConnectionStringParse();
    const weakened = parse(`${goodUrl}&sslmode=no-verify`) as {
      ssl: { rejectUnauthorized?: boolean };
    };
    assert.equal(weakened.ssl.rejectUnauthorized, false);
    assert.equal(parse(`${goodUrl}&password=secret`).password, "secret");
    assert.equal(parse(`${goodUrl}&host=other.example`).host, "other.example");
  });
});
