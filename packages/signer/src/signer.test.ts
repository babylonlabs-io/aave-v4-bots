import { describe, expect, it, vi } from "vitest";
import { buildSignerConfig, createLocalSigner, createSigner } from "./index";

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

  // `createAwsSigner` (the real AWS KMS adapter) is covered in `aws.test.ts`.

  describe("buildSignerConfig", () => {
    it("defaults to a local signer whose keyRef is the service default", () => {
      expect(
        buildSignerConfig({ source: "local", defaultKeyRef: "LIQUIDATOR_PRIVATE_KEY" })
      ).toEqual({ source: "local", keyRef: "LIQUIDATOR_PRIVATE_KEY" });
    });

    it("uses an explicit keyRef over the default when given", () => {
      expect(
        buildSignerConfig({ source: "local", keyRef: "MY_KEY", defaultKeyRef: "DEFAULT" })
      ).toEqual({ source: "local", keyRef: "MY_KEY" });
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
