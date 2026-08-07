import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  addressListSchema,
  addressSchema,
  buildExecutionConfig,
  buildNotifierConfig,
  bytes32Schema,
  nonNegativeIntSchema,
  parseEnv,
  positiveIntSchema,
  urlSchema,
} from "./index";

const ADDR = "0x1234567890123456789012345678901234567890";
const KEY = `0x${"a".repeat(64)}`;

describe("@repo/config schemas", () => {
  it("addressSchema accepts a 20-byte hex address, rejects malformed", () => {
    expect(addressSchema.safeParse(ADDR).success).toBe(true);
    expect(addressSchema.safeParse("0x1234").success).toBe(false); // too short
    expect(addressSchema.safeParse(`${ADDR}ab`).success).toBe(false); // too long
    expect(addressSchema.safeParse("1234567890123456789012345678901234567890").success).toBe(false); // no 0x
  });

  it("bytes32Schema accepts 32-byte hex, rejects others", () => {
    expect(bytes32Schema.safeParse(KEY).success).toBe(true);
    expect(bytes32Schema.safeParse(ADDR).success).toBe(false); // 20 bytes, not 32
  });

  it("urlSchema validates URLs", () => {
    expect(urlSchema.safeParse("http://localhost:42069").success).toBe(true);
    expect(urlSchema.safeParse("not-a-url").success).toBe(false);
  });

  describe("positiveIntSchema", () => {
    it("accepts a positive integer string", () => {
      expect(positiveIntSchema.safeParse("12000").success).toBe(true);
    });

    // Regression: `Number.parseInt` would silently accept these; the /^\d+$/ regex must not.
    it.each(["1abc", "1.5", "12 ", " 12", "0x10", ""])("rejects truncatable input %j", (bad) => {
      expect(positiveIntSchema.safeParse(bad).success).toBe(false);
    });

    it("rejects zero and negatives", () => {
      expect(positiveIntSchema.safeParse("0").success).toBe(false);
      expect(positiveIntSchema.safeParse("-1").success).toBe(false); // '-' fails the digit regex
    });
  });

  describe("nonNegativeIntSchema", () => {
    it("accepts zero", () => {
      expect(nonNegativeIntSchema.safeParse("0").success).toBe(true);
    });
    it("rejects truncatable input", () => {
      expect(nonNegativeIntSchema.safeParse("1abc").success).toBe(false);
    });
  });

  describe("addressListSchema", () => {
    it("parses a comma-separated list, trimming and dropping empties", () => {
      const other = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      const result = addressListSchema.safeParse(` ${ADDR}, ${other} ,`);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([ADDR, other]);
    });

    it("parses an empty string to an empty list", () => {
      const result = addressListSchema.safeParse("   ");
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([]);
    });

    it("rejects a list containing an invalid address", () => {
      expect(addressListSchema.safeParse(`${ADDR},0xnope`).success).toBe(false);
    });
  });
});

describe("parseEnv", () => {
  const schema = z.object({
    REQUIRED: urlSchema,
    OPTIONAL: positiveIntSchema.optional().default("10"),
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns typed data on success", () => {
    const parsed = parseEnv(schema, { REQUIRED: "http://x", OPTIONAL: "5" });
    expect(parsed).toEqual({ REQUIRED: "http://x", OPTIONAL: "5" });
  });

  it("treats empty-string env vars as unset so defaults apply", () => {
    const parsed = parseEnv(schema, { REQUIRED: "http://x", OPTIONAL: "" });
    expect(parsed.OPTIONAL).toBe("10");
  });

  it("fails fast with process.exit(1) when a required var is missing", () => {
    expect(() => parseEnv(schema, {})).toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalled();
  });

  it("fails fast when a value is invalid", () => {
    expect(() => parseEnv(schema, { REQUIRED: "not-a-url" })).toThrow("process.exit:1");
  });
});

describe("buildNotifierConfig", () => {
  const base = { SECRETS_PROVIDER: "env" } as const;

  it("defaults to the log-only `none` backend", () => {
    expect(buildNotifierConfig({ ...base, NOTIFIER: "none" })).toEqual({
      source: "none",
      webhookRef: undefined,
    });
  });

  it("carries the webhook reference through for `slack`", () => {
    expect(
      buildNotifierConfig({ ...base, NOTIFIER: "slack", SLACK_WEBHOOK_REF: "SLACK_URL" })
    ).toEqual({ source: "slack", webhookRef: "SLACK_URL" });
  });

  it("rejects `slack` with no webhook reference at config time, not at first alert", () => {
    expect(() => buildNotifierConfig({ ...base, NOTIFIER: "slack" })).toThrow(/SLACK_WEBHOOK_REF/);
  });
});

describe("buildExecutionConfig", () => {
  // A valid MANUAL setup: the broadcasting address + a store, and NO signer configured.
  const manualBase = {
    EXECUTION_MODE: "MANUAL",
    MANUAL_EXECUTOR_ADDRESS: ADDR,
    MANUAL_EXECUTOR_KIND: "eoa",
    MANUAL_INTENT_TTL_MS: "10800000",
    MANUAL_INTENT_STUCK_MS: "3600000",
    DATABASE_URL: "postgres://x",
    SIGNER_SOURCE: "local",
  } as const;

  it("AUTO carries no key-shaped fields (and ignores signer/store + MANUAL-only vars)", () => {
    expect(
      buildExecutionConfig({
        EXECUTION_MODE: "AUTO",
        SIGNER_SOURCE: "local",
        SIGNER_KEY_REF: "K",
        // AUTO needs no custody declaration — a stray one is ignored, never required.
        MANUAL_EXECUTOR_KIND: "safe",
        MANUAL_INTENT_TTL_MS: "10800000",
        MANUAL_INTENT_STUCK_MS: "3600000",
      })
    ).toEqual({ mode: "AUTO" });
  });

  it("MANUAL carries the broadcasting address, custody kind + proposal TTL", () => {
    expect(buildExecutionConfig(manualBase)).toEqual({
      mode: "MANUAL",
      manualExecutorAddress: ADDR,
      executorKind: "eoa",
      intentTtlMs: 10_800_000,
      intentStuckMs: 3_600_000,
    });
  });

  it("MANUAL carries a `safe` custody kind", () => {
    expect(buildExecutionConfig({ ...manualBase, MANUAL_EXECUTOR_KIND: "safe" })).toMatchObject({
      mode: "MANUAL",
      executorKind: "safe",
    });
  });

  it("rejects MANUAL without a declared custody kind", () => {
    expect(() => buildExecutionConfig({ ...manualBase, MANUAL_EXECUTOR_KIND: undefined })).toThrow(
      /MANUAL_EXECUTOR_KIND/
    );
  });

  it("rejects MANUAL without a broadcasting address", () => {
    expect(() =>
      buildExecutionConfig({ ...manualBase, MANUAL_EXECUTOR_ADDRESS: undefined })
    ).toThrow(/MANUAL_EXECUTOR_ADDRESS/);
  });

  it("rejects MANUAL without a persisted store (proposals must survive a restart)", () => {
    expect(() => buildExecutionConfig({ ...manualBase, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/
    );
  });

  // The keyless promise: a MANUAL process must not carry a signer, so a mis-set one fails at boot.
  it.each([
    ["SIGNER_SOURCE=aws", { SIGNER_SOURCE: "aws" as const }],
    ["SIGNER_KEY_REF", { SIGNER_KEY_REF: "LIQUIDATOR_PRIVATE_KEY" }],
    ["KMS_KEY_ID", { KMS_KEY_ID: "arn:aws:kms:..." }],
    ["SIGNER_ADDRESS", { SIGNER_ADDRESS: ADDR }],
  ])("rejects MANUAL with a configured signer (%s)", (needle, extra) => {
    expect(() => buildExecutionConfig({ ...manualBase, ...extra })).toThrow(needle);
  });

  // The gap the schema-field checks can't see: no explicit signer var, but the raw key sits in the
  // process env. A compromised MANUAL process could read + exfiltrate it, so boot must reject it.
  it("rejects MANUAL when the raw signing key is present in the env", () => {
    expect(() => buildExecutionConfig(manualBase, { signerKeyPresent: true })).toThrow(
      /keyless|signing key/
    );
  });

  it("allows MANUAL when no signing key is present", () => {
    expect(buildExecutionConfig(manualBase, { signerKeyPresent: false })).toEqual({
      mode: "MANUAL",
      manualExecutorAddress: ADDR,
      executorKind: "eoa",
      intentTtlMs: 10_800_000,
      intentStuckMs: 3_600_000,
    });
  });

  it("parses a custom TTL, and 0 to disable expiry", () => {
    expect(buildExecutionConfig({ ...manualBase, MANUAL_INTENT_TTL_MS: "0" })).toMatchObject({
      intentTtlMs: 0,
    });
    expect(buildExecutionConfig({ ...manualBase, MANUAL_INTENT_TTL_MS: "60000" })).toMatchObject({
      intentTtlMs: 60_000,
    });
  });

  it("parses the intent-stuck threshold, and 0 to disable it", () => {
    expect(buildExecutionConfig({ ...manualBase, MANUAL_INTENT_STUCK_MS: "0" })).toMatchObject({
      intentStuckMs: 0,
    });
    expect(buildExecutionConfig({ ...manualBase, MANUAL_INTENT_STUCK_MS: "90000" })).toMatchObject({
      intentStuckMs: 90_000,
    });
  });
});
