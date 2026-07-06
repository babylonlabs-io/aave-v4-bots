import { describe, expect, it, vi } from "vitest";
import { createKmsSigner, createLocalSigner, createPublicSubmitter } from "./index";

// Anvil account[0].
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("@repo/signer", () => {
  describe("createLocalSigner", () => {
    it("derives the correct address from the private key", () => {
      const signer = createLocalSigner(KEY);
      expect(signer.address).toBe(ADDR);
      expect(signer.account.address).toBe(ADDR);
    });

    it("produces a usable viem account (can sign a message)", async () => {
      const signer = createLocalSigner(KEY);
      const sig = await signer.account.signMessage?.({ message: "hello" });
      expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    });
  });

  describe("createKmsSigner (stub)", () => {
    it("exposes the configured address but throws on sign", async () => {
      const signer = createKmsSigner({ keyId: "arn:test", address: ADDR });
      expect(signer.address).toBe(ADDR);
      await expect(signer.account.signTransaction?.({ chainId: 1 } as never)).rejects.toThrow(
        /KMS signer not implemented/
      );
    });
  });

  describe("createPublicSubmitter", () => {
    it("broadcasts the serialized tx via the client and returns the hash", async () => {
      const client = { sendRawTransaction: vi.fn().mockResolvedValue("0xhash") };
      const submitter = createPublicSubmitter(client);

      const hash = await submitter.send("0xsigned");

      expect(hash).toBe("0xhash");
      expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: "0xsigned" });
    });
  });
});
