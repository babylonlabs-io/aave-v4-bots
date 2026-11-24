import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPoolConfig } from "./poolConfig";

const caFile = path.join(os.tmpdir(), `persistence-pool-ca-${process.pid}.pem`);
fs.writeFileSync(caFile, "CA-BUNDLE\n");
const iamUrl = `postgresql://bot_user@db.example.internal:5432/bot_db?sslmode=verify-full&sslrootcert=${caFile}`;
const signerFactory = () => ({ getAuthToken: async () => "iam-token" });

describe("buildPoolConfig", () => {
  it("passes the URL through in password mode", () => {
    const url = "postgres://u:p@localhost/bot";
    expect(buildPoolConfig({ connectionString: url })).toEqual({ connectionString: url });
    expect(buildPoolConfig({ connectionString: url, auth: "password" })).toEqual({
      connectionString: url,
    });
  });

  it("connects with a per-connection IAM token and verified TLS in iam mode", async () => {
    const cfg = buildPoolConfig(
      { connectionString: iamUrl, auth: "iam" },
      { env: { AWS_REGION: "ap-east-1" }, signerFactory }
    );

    // No connectionString: pg would merge the URL's empty password over the token function.
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg).toMatchObject({
      host: "db.example.internal",
      port: 5432,
      user: "bot_user",
      database: "bot_db",
      ssl: { ca: "CA-BUNDLE\n", rejectUnauthorized: true },
    });
    expect(typeof cfg.password).toBe("function");
    expect(await (cfg.password as () => Promise<string>)()).toBe("iam-token");
  });

  it("copies only connection fields into the pool config", () => {
    const cfg = buildPoolConfig(
      { connectionString: `${iamUrl}&application_name=bot`, auth: "iam" },
      { env: {}, signerFactory }
    );
    expect(Object.keys(cfg).sort()).toEqual(
      ["application_name", "database", "host", "password", "port", "ssl", "user"].sort()
    );
    expect(cfg.application_name).toBe("bot");
  });

  it("refuses query keys iam mode would drop, instead of ignoring them", () => {
    for (const extra of ["max=1", "options=-c%20search_path%3Dx", "statement_timeout=5"]) {
      expect(() =>
        buildPoolConfig(
          { connectionString: `${iamUrl}&${extra}`, auth: "iam" },
          { env: {}, signerFactory }
        )
      ).toThrow(/not supported in iam mode/);
    }
  });

  it("passes the AWS region to the signer", async () => {
    let region: string | undefined;
    const cfg = buildPoolConfig(
      { connectionString: iamUrl, auth: "iam" },
      {
        env: { AWS_REGION: "ap-east-1" },
        signerFactory: (t) => {
          region = t.region;
          return { getAuthToken: async () => "t" };
        },
      }
    );
    await (cfg.password as () => Promise<string>)();
    expect(region).toBe("ap-east-1");
  });

  it("uses port 5432 when the URL has none", () => {
    const cfg = buildPoolConfig(
      { connectionString: iamUrl.replace(":5432", ""), auth: "iam" },
      { env: {}, signerFactory }
    );
    expect(cfg.port).toBe(5432);
  });

  it("refuses a URL that would bypass the token", () => {
    const withPassword = iamUrl.replace("bot_user@", "bot_user:secret@");
    expect(() =>
      buildPoolConfig({ connectionString: withPassword, auth: "iam" }, { env: {}, signerFactory })
    ).toThrow(/carries a password/);
    expect(() =>
      buildPoolConfig(
        { connectionString: iamUrl.replace("verify-full", "require"), auth: "iam" },
        { env: {}, signerFactory }
      )
    ).toThrow(/verify-full/);
  });

  it("refuses PGPASSWORD in iam mode", () => {
    expect(() =>
      buildPoolConfig(
        { connectionString: iamUrl, auth: "iam" },
        { env: { PGPASSWORD: "x" }, signerFactory }
      )
    ).toThrow(/PGPASSWORD/);
  });
});
