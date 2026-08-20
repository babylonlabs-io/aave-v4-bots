import { describe, expect, it, vi } from "vitest";
import { buildSignerConfig, createLocalSigner, createSigner, resolveSigner } from "./index";

// Anvil account[0].
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("@repo/signer", () => {
  describe("createLocalSigner", () => {
    it("derives the correct address from the private key", () => {
      const signer = createLocalSigner(KEY);
      expect(signer.account.address).toBe(ADDR);
      expect(signer.account.address).toBe(ADDR);
    });

    it("produces a usable viem account (can sign a message)", async () => {
      const signer = createLocalSigner(KEY);
      const sig = await signer.account.signMessage?.({ message: "hello" });
      expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    // The same assertion `createAwsSigner` makes about a KMS key, for the same reason: with the key
    // behind a secret ref, the account it derives is invisible until something derives it. A
    // rotated or mistyped ref otherwise boots a bot signing as an account nobody funded — which
    // shows up as every action being unaffordable, not as an error.
    describe("the expected address", () => {
      it("accepts the key that derives it, whatever the casing", () => {
        expect(createLocalSigner(KEY, ADDR.toLowerCase() as `0x${string}`).account.address).toBe(
          ADDR
        );
      });

      it("refuses a key that derives a different address", () => {
        const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
        expect(() => createLocalSigner(KEY, other)).toThrow(
          `the configured signing key derives address ${ADDR}, not the configured ${other}`
        );
      });

      it("never echoes the key while refusing", () => {
        const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
        expect(() => createLocalSigner(KEY, other)).not.toThrow(new RegExp(KEY));
      });

      it("is optional — an unset one asserts nothing", () => {
        expect(createLocalSigner(KEY).account.address).toBe(ADDR);
      });
    });

    // The key-shape guard used to live in each service's zod config schema; it now
    // lives at this boundary. The thrown error must never echo the key material.
    it.each([
      ["missing 0x prefix", KEY.slice(2)],
      ["too short", "0x1234"],
      ["too long", `${KEY}00`],
      ["non-hex chars", `0x${"z".repeat(64)}`],
      ["empty", ""],
    ])("rejects an invalid private key (%s)", (_name, bad) => {
      expect(() => createLocalSigner(bad)).toThrow(/invalid private key/);
      expect(() => createLocalSigner(bad)).not.toThrow(new RegExp(bad || "\\bWONT_MATCH\\b"));
    });
  });

  // Where the value comes from. It reached the aws branch and was dropped on the local one, so a
  // deployment that set it as a wrong-key tripwire got neither the check nor a word about it.
  describe("resolveSigner", () => {
    it("enforces the expected address against the resolved local key", async () => {
      const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

      await expect(
        resolveSigner({ source: "local", keyRef: "SIGNING_KEY", address: other }, async () => KEY)
      ).rejects.toThrow(/derives address/);
    });

    it("resolves the ref and signs as the address it expected", async () => {
      const signer = await resolveSigner(
        { source: "local", keyRef: "SIGNING_KEY", address: ADDR },
        async (ref) => {
          expect(ref).toBe("SIGNING_KEY");
          return KEY;
        }
      );

      expect(signer.account.address).toBe(ADDR);
    });
  });

  // `createAwsSigner` (the real AWS KMS adapter) is covered in `aws.test.ts`.

  describe("buildSignerConfig", () => {
    it("defaults to a local signer whose keyRef is the service default", () => {
      expect(
        buildSignerConfig({ source: "local", defaultKeyRef: "LIQUIDATOR_PRIVATE_KEY" })
      ).toEqual({ source: "local", keyRef: "LIQUIDATOR_PRIVATE_KEY", address: undefined });
    });

    it("carries an expected address onto a local signer, not only an aws one", () => {
      expect(
        buildSignerConfig({
          source: "local",
          defaultKeyRef: "LIQUIDATOR_PRIVATE_KEY",
          address: ADDR,
        })
      ).toEqual({ source: "local", keyRef: "LIQUIDATOR_PRIVATE_KEY", address: ADDR });
    });

    it("uses an explicit keyRef over the default when given", () => {
      expect(
        buildSignerConfig({ source: "local", keyRef: "MY_KEY", defaultKeyRef: "DEFAULT" })
      ).toEqual({ source: "local", keyRef: "MY_KEY", address: undefined });
    });

    it("builds an aws signer config from the KMS fields", () => {
      expect(
        buildSignerConfig({
          source: "aws",
          defaultKeyRef: "UNUSED",
          kmsKeyId: "arn:aws:kms:...:key/abc",
          address: ADDR,
          region: "us-east-1",
        })
      ).toEqual({
        source: "aws",
        keyId: "arn:aws:kms:...:key/abc",
        address: ADDR,
        region: "us-east-1",
      });
    });

    it("throws when source=aws but no KMS key id is set", () => {
      expect(() => buildSignerConfig({ source: "aws", defaultKeyRef: "UNUSED" })).toThrow(
        /SIGNER_SOURCE=aws requires KMS_KEY_ID/
      );
    });
  });

  describe("createSigner", () => {
    it("builds a local signer from the resolved private key", async () => {
      const signer = await createSigner({ source: "local", privateKey: KEY });
      expect(signer.account.address).toBe(ADDR);
    });

    it("surfaces an invalid resolved key (validation happens in the local signer)", async () => {
      await expect(createSigner({ source: "local", privateKey: "not-a-key" })).rejects.toThrow(
        /invalid private key/
      );
    });
    // The `aws` route just forwards to `createAwsSigner`, covered in `aws.test.ts`.
  });
});
