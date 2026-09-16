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

  it("sends a Secrets Manager ARN as the SecretId", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/bot-AbCdEf";
    const send = vi.fn(async (command: GetSecretValueCommand) => {
      expect(command.input.SecretId).toBe(arn);
      return { SecretString: "value" };
    });
    await expect(createAwsSecrets({ client: { send } }).get(arn, "TEST_REF")).resolves.toBe(
      "value"
    );
  });

  it("wraps client errors without echoing the ref", async () => {
    const send = vi.fn(async () => {
      throw new Error(
        "ResourceNotFoundException: Secrets Manager can't find the specified secret."
      );
    });
    const secrets = createAwsSecrets({ client: { send } });
    await expect(secrets.get("missing/ref", "TEST_REF")).rejects.toThrow(
      /failed to fetch secret <11 chars>.*ResourceNotFound/
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
        /has no JSON key <4 chars>/
      );
    });

    it("throws when the secret is not valid JSON", async () => {
      const send = vi.fn(async () => ({ SecretString: "not-json" }));
      const secrets = createAwsSecrets({ client: { send } });
      await expect(secrets.get("plain/secret#KEY", "TEST_REF")).rejects.toThrow(
        /is not valid JSON/
      );
    });

    // The selector is part of the ref, so a secret pasted after `#` is refused like one before it.
    it("refuses a secret-shaped selector before the fetch", async () => {
      const send = vi.fn();
      const key = "ab".repeat(32);
      const error = await createAwsSecrets({ client: { send } })
        .get(`prod/bot/config#${key}`, "SIGNER_KEY_REF")
        .then(
          () => new Error("expected the lookup to be refused"),
          (e: Error) => e
        );

      expect(send).not.toHaveBeenCalled();
      expect(error.message).toMatch(/SIGNER_KEY_REF \(JSON key\) is not the name of a secret/);
      expect(error.message).not.toContain(key);
    });

    // A selector that passes the gate can still be a secret of another shape.
    it.each([
      ["not valid JSON", "not-json"],
      ["not a JSON object", "[1]"],
      ["missing the key", JSON.stringify({ OTHER: "x" })],
    ])("never echoes the selector when the secret is %s", async (_label, secretString) => {
      const selector = "q3Vx7Zk2Lm9Pn4Rt8Ws1Yb6Cd0Ef5Gh2Ij3Kl7Mn8=";
      const send = vi.fn(async () => ({ SecretString: secretString }));
      const error = await createAwsSecrets({ client: { send } })
        .get(`prod/bot/config#${selector}`, "TEST_REF")
        .then(
          () => new Error("expected the lookup to fail"),
          (e: Error) => e
        );

      expect(send).toHaveBeenCalled();
      expect(error.message).not.toContain(selector);
    });
  });
});
