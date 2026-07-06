import { describe, expect, it } from "vitest";
import { createAwsSecrets, createEnvSecrets } from "./index";

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

  describe("createAwsSecrets", () => {
    it("is a stub that throws until implemented", async () => {
      await expect(createAwsSecrets().get("anything")).rejects.toThrow(/not implemented/);
    });
  });
});
