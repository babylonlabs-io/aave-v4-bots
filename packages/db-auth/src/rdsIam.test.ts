import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type IamTarget,
  assertIamEnvironment,
  awsRegionFromEnv,
  createIamTokenSource,
  iamTargetFromUrl,
  parseDbAuthMode,
} from "./rdsIam";

const caFile = path.join(os.tmpdir(), `db-auth-unit-ca-${process.pid}.pem`);
fs.writeFileSync(caFile, "not a real certificate\n");
const url = `postgresql://bot_user@db.example.internal:5432/bot?sslmode=verify-full&sslrootcert=${caFile}`;

describe("parseDbAuthMode", () => {
  it("defaults to password and accepts iam", () => {
    expect(parseDbAuthMode(undefined)).toBe("password");
    expect(parseDbAuthMode("")).toBe("password");
    expect(parseDbAuthMode("iam")).toBe("iam");
  });

  it("rejects anything else without echoing the value", () => {
    expect(() => parseDbAuthMode("IAM")).toThrow(/DB_AUTH must be/);
    expect(() => parseDbAuthMode("postgresql://u:secret@h/db")).toThrow(/^((?!secret).)*$/);
  });
});

describe("assertIamEnvironment", () => {
  it("refuses PGPASSWORD and disabled TLS verification", () => {
    expect(() => assertIamEnvironment({ PGPASSWORD: "x" })).toThrow(/PGPASSWORD/);
    expect(() => assertIamEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED/
    );
    expect(() => assertIamEnvironment({})).not.toThrow();
  });
});

describe("iamTargetFromUrl", () => {
  it("ignores AWS env vars: the target is host, port and user only", () => {
    expect(iamTargetFromUrl(url, { AWS_REGION: "ap-east-1" })).toEqual({
      hostname: "db.example.internal",
      port: 5432,
      username: "bot_user",
    });
  });

  it("refuses a connectionString query parameter, which pg re-parses as a new URL", () => {
    const nested = `${url}&connectionString=${encodeURIComponent("postgres://evil.example/x?sslmode=disable")}`;
    expect(() => iamTargetFromUrl(nested, {})).toThrow(/connectionString/);
  });

  it("refuses a URL without a database name", () => {
    const noDb = url.replace("/bot?", "/?");
    expect(() => iamTargetFromUrl(noDb, {})).toThrow(/no database name/);
  });

  it("refuses a URL that carries a password", () => {
    const withPassword = url.replace("bot_user@", "bot_user:secret@");
    expect(() => iamTargetFromUrl(withPassword, {})).toThrow(/carries a password/);
  });
});

describe("awsRegionFromEnv", () => {
  it("prefers AWS_REGION, falls back to AWS_DEFAULT_REGION, and drops empty values", () => {
    expect(awsRegionFromEnv({ AWS_REGION: "ap-east-1", AWS_DEFAULT_REGION: "x" })).toBe(
      "ap-east-1"
    );
    expect(awsRegionFromEnv({ AWS_DEFAULT_REGION: "us-east-1" })).toBe("us-east-1");
    expect(awsRegionFromEnv({ AWS_REGION: "" })).toBeUndefined();
  });
});

describe("createIamTokenSource", () => {
  const target: IamTarget = { hostname: "h", port: 5432, username: "u", region: "r" };

  it("builds the signer once and mints a fresh token per call", async () => {
    let n = 0;
    const factory = vi.fn(() => ({ getAuthToken: async () => `token-${++n}` }));
    const getToken = createIamTokenSource(target, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(await getToken()).toBe("token-1");
    expect(await getToken()).toBe("token-2");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(target);
  });

  it("surfaces a signer failure to the caller", async () => {
    const getToken = createIamTokenSource(target, () => ({
      getAuthToken: async () => {
        throw new Error("no credentials");
      },
    }));
    await expect(getToken()).rejects.toThrow(/no credentials/);
  });
});
