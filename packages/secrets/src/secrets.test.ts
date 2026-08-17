import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsSecrets, createEnvSecrets, createSecrets } from "./index";

// A ref names a secret; it is never the secret. The two sit one line apart in every example file
// (`SIGNER_KEY_REF=BOT_KEY` above `BOT_KEY=0x…`), so pasting the value where the name belongs is an
// ordinary mistake — and it used to end with the key in the fatal boot log, which is replicated and
// retained far more widely than a process environment.
describe("a ref that is really the secret", () => {
  const KEY = `0x${"a".repeat(64)}`;
  const WEBHOOK = "https://hooks.slack.com/services/T00/B00/XXXXXXXXXXXX";

  it.each([KEY, WEBHOOK, "0xDEADBEEF".repeat(6)])(
    "is refused without appearing in the error (%#)",
    async (value) => {
      const error = await createEnvSecrets({})
        .get(value, "SIGNER_KEY_REF")
        .then(
          () => new Error("expected the lookup to be refused"),
          (e: Error) => e
        );

      expect(error.message).not.toContain(value);
      expect(error.message).toMatch(/SIGNER_KEY_REF is not the name of a secret/);
    }
  );

  it("says how long the value was, which is what identifies the mistake", async () => {
    await expect(createEnvSecrets({}).get(KEY, "SIGNER_KEY_REF")).rejects.toThrow(
      /<redacted, 66 chars>/
    );
  });

  // Refused before the fetch, not merely redacted afterwards: the id would otherwise become the
  // `SecretId` of a `GetSecretValue` call, which AWS records in CloudTrail.
  it("never reaches AWS", async () => {
    const send = vi.fn();

    await expect(createAwsSecrets({ client: { send } }).get(KEY, "SIGNER_KEY_REF")).rejects.toThrow(
      /not the name of a secret/
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["BOT_KEY", "prod/liquidator/key", "prod/bot/config", "AWS_SECRET-1.2"])(
    "still allows an ordinary name (%s)",
    async (ref) => {
      await expect(createEnvSecrets({ [ref]: "value" }).get(ref, "SIGNER_KEY_REF")).resolves.toBe(
        "value"
      );
    }
  );
});

describe("@repo/secrets", () => {
  describe("createEnvSecrets", () => {
    it("resolves a ref from the provided env", async () => {
      const secrets = createEnvSecrets({ FOO: "bar" });
      await expect(secrets.get("FOO", "TEST_REF")).resolves.toBe("bar");
    });

    it("throws on a missing ref", async () => {
      const secrets = createEnvSecrets({});
      await expect(secrets.get("MISSING", "TEST_REF")).rejects.toThrow(
        /TEST_REF: no environment variable named "MISSING" is set/
      );
    });

    it("treats an empty-string value as unset", async () => {
      const secrets = createEnvSecrets({ EMPTY: "" });
      await expect(secrets.get("EMPTY", "TEST_REF")).rejects.toThrow(/is set/);
    });
  });

  describe("createSecrets (selector)", () => {
    afterEach(() => {
      process.env.SELECTOR_TEST = undefined;
    });

    it("source=env resolves from process.env", async () => {
      process.env.SELECTOR_TEST = "value";
      const secrets = createSecrets({ source: "env" });
      await expect(secrets.get("SELECTOR_TEST", "TEST_REF")).resolves.toBe("value");
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
