import { afterEach, describe, expect, it } from "vitest";
import { createEnvSecrets, createSecrets } from "./index";

describe("@repo/secrets", () => {
  describe("createEnvSecrets", () => {
    it("resolves a ref from the provided env", async () => {
      const secrets = createEnvSecrets({ FOO: "bar" });
      await expect(secrets.get("FOO")).resolves.toBe("bar");
    });

    it("throws on a missing ref", async () => {
      const secrets = createEnvSecrets({});
      await expect(secrets.get("MISSING")).rejects.toThrow(/MISSING.*not set/);
    });

    it("treats an empty-string value as unset", async () => {
      const secrets = createEnvSecrets({ EMPTY: "" });
      await expect(secrets.get("EMPTY")).rejects.toThrow(/not set/);
    });
  });

  describe("createSecrets (selector)", () => {
    afterEach(() => {
      process.env.SELECTOR_TEST = undefined;
    });

    it("source=env resolves from process.env", async () => {
      process.env.SELECTOR_TEST = "value";
      const secrets = createSecrets({ source: "env" });
      await expect(secrets.get("SELECTOR_TEST")).resolves.toBe("value");
    });

    it("source=aws builds an AWS-backed provider (no call made here)", () => {
      const secrets = createSecrets({ source: "aws", region: "us-east-1" });
      expect(typeof secrets.get).toBe("function");
    });

    it("throws on an unknown source", () => {
      expect(() => createSecrets({ source: "vault" as never })).toThrow(/unknown secrets source/);
    });
  });
});
