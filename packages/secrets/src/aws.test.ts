import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { type SecretsSend, createAwsSecrets } from "./aws";

describe("createAwsSecrets", () => {
  it("resolves a SecretString for a ref", async () => {
    const send = vi.fn(async (command: GetSecretValueCommand) => {
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input.SecretId).toBe("prod/liquidator/key");
      return { SecretString: "0xabc123" };
    });
    const secrets = createAwsSecrets({ client: { send } });
    await expect(secrets.get("prod/liquidator/key", "TEST_REF")).resolves.toBe("0xabc123");
  });

  it("decodes a SecretBinary when there is no SecretString", async () => {
    const send = vi.fn(async () => ({ SecretBinary: Buffer.from("hunter2", "utf8") }));
    const secrets = createAwsSecrets({ client: { send } });
    await expect(secrets.get("bin/secret", "TEST_REF")).resolves.toBe("hunter2");
  });

  it("wraps client errors with the ref (never the value)", async () => {
    const send = vi.fn(async () => {
      throw new Error(
        "ResourceNotFoundException: Secrets Manager can't find the specified secret."
      );
    });
    const secrets = createAwsSecrets({ client: { send } });
    await expect(secrets.get("missing/ref", "TEST_REF")).rejects.toThrow(
      /failed to fetch secret "missing\/ref".*ResourceNotFound/
    );
  });

  it("throws when the secret has neither string nor binary value", async () => {
    const send: SecretsSend["send"] = vi.fn(async () => ({}));
    const secrets = createAwsSecrets({ client: { send } });
    await expect(secrets.get("empty/ref", "TEST_REF")).rejects.toThrow(/has no value/);
  });

  describe("#jsonKey selector (JSON secret)", () => {
    const jsonSecret = () =>
      vi.fn(async (command: GetSecretValueCommand) => {
        // the `#...` suffix must be stripped before hitting the API
        expect(command.input.SecretId).toBe("prod/liquidator/config");
        return {
          SecretString: JSON.stringify({
            LIQUIDATOR_PRIVATE_KEY: "0xdeadbeef",
            METRICS_PORT: 9090,
          }),
        };
      });

    it("extracts a string field from a JSON secret", async () => {
      const secrets = createAwsSecrets({ client: { send: jsonSecret() } });
      await expect(
        secrets.get("prod/liquidator/config#LIQUIDATOR_PRIVATE_KEY", "TEST_REF")
      ).resolves.toBe("0xdeadbeef");
    });

    it("stringifies a non-string field", async () => {
      const secrets = createAwsSecrets({ client: { send: jsonSecret() } });
      await expect(secrets.get("prod/liquidator/config#METRICS_PORT", "TEST_REF")).resolves.toBe(
        "9090"
      );
    });

    it("throws when the JSON key is absent", async () => {
      const secrets = createAwsSecrets({ client: { send: jsonSecret() } });
      await expect(secrets.get("prod/liquidator/config#NOPE", "TEST_REF")).rejects.toThrow(
        /has no JSON key "NOPE"/
      );
    });

    it("throws when the secret is not valid JSON", async () => {
      const send = vi.fn(async () => ({ SecretString: "not-json" }));
      const secrets = createAwsSecrets({ client: { send } });
      await expect(secrets.get("plain/secret#KEY", "TEST_REF")).rejects.toThrow(
        /is not valid JSON/
      );
    });
  });
});
