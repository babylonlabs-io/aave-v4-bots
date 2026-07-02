import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  addressListSchema,
  addressSchema,
  bytes32Schema,
  nonNegativeIntSchema,
  parseEnv,
  positiveIntSchema,
  privateKeySchema,
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

  it("privateKeySchema / bytes32Schema accept 32-byte hex, reject others", () => {
    expect(privateKeySchema.safeParse(KEY).success).toBe(true);
    expect(bytes32Schema.safeParse(KEY).success).toBe(true);
    expect(privateKeySchema.safeParse(ADDR).success).toBe(false); // 20 bytes, not 32
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
