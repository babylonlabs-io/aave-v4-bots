import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  type TransactionSerializedLegacy,
  hexToBytes,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { type KmsSend, createAwsSigner } from "./aws";
import { createLocalSigner } from "./index";

// Anvil account[0]. The mock KMS client below signs with this real key, so every
// signature the KMS signer produces must genuinely recover to ADDR — this exercises the
// full DER-parse → low-s → recovery-id → serialize pipeline without touching AWS.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const privBytes = hexToBytes(KEY);
const pubUncompressed = secp256k1.getPublicKey(privBytes, false); // 65 bytes: 0x04 ‖ X ‖ Y
// DER SubjectPublicKeyInfo prefix for a secp256k1 key; the uncompressed point follows.
const SPKI_PREFIX = hexToBytes("0x3056301006072a8648ce3d020106052b8104000a034200");
const spkiDer = new Uint8Array([...SPKI_PREFIX, ...pubUncompressed]);

const VALID_KEY_META = {
  KeySpec: "ECC_SECG_P256K1",
  KeyUsage: "SIGN_VERIFY",
  SigningAlgorithms: ["ECDSA_SHA_256"],
};

/** A fake `KMSClient` that answers `GetPublicKey`/`Sign` using the real Anvil key. */
function mockKms(options: { forceHighS?: boolean } = {}): KmsSend {
  return {
    async send(command) {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: spkiDer, ...VALID_KEY_META };
      }
      if (command instanceof SignCommand) {
        const digest = command.input.Message as Uint8Array;
        const sig = secp256k1.sign(digest, privBytes, { lowS: !options.forceHighS });
        if (options.forceHighS && !sig.hasHighS()) {
          // Flip to the malleable high-s twin so the adapter's normalization is exercised.
          const twin = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
          return { Signature: twin.toDERRawBytes() };
        }
        return { Signature: sig.toDERRawBytes() };
      }
      throw new Error("unexpected KMS command");
    },
  };
}

describe("@repo/signer ./aws", () => {
  it("derives the same address as the local signer for the same key", async () => {
    const signer = await createAwsSigner({ keyId: "arn:test", client: mockKms() });
    expect(signer.address).toBe(ADDR);
    expect(signer.address).toBe(createLocalSigner(KEY).address);
  });

  it("fails fast when the configured address does not match the key", async () => {
    await expect(
      createAwsSigner({
        keyId: "arn:test",
        address: "0x0000000000000000000000000000000000000001",
        client: mockKms(),
      })
    ).rejects.toThrow(/does not match|not the configured/);
  });

  it("throws when KMS returns no public key", async () => {
    const client: KmsSend = {
      async send() {
        return {};
      },
    };
    await expect(createAwsSigner({ keyId: "arn:test", client })).rejects.toThrow(/no key/);
  });

  it("rejects a key on the wrong curve (KeySpec guard)", async () => {
    const client: KmsSend = {
      async send(command) {
        if (command instanceof GetPublicKeyCommand) {
          return { PublicKey: spkiDer, KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" };
        }
        throw new Error("should not sign");
      },
    };
    await expect(createAwsSigner({ keyId: "arn:test", client })).rejects.toThrow(
      /KeySpec ECC_NIST_P256, expected ECC_SECG_P256K1/
    );
  });

  it("rejects an encrypt-only key (KeyUsage guard)", async () => {
    const client: KmsSend = {
      async send(command) {
        if (command instanceof GetPublicKeyCommand) {
          return { PublicKey: spkiDer, KeySpec: "ECC_SECG_P256K1", KeyUsage: "ENCRYPT_DECRYPT" };
        }
        throw new Error("should not sign");
      },
    };
    await expect(createAwsSigner({ keyId: "arn:test", client })).rejects.toThrow(
      /KeyUsage ENCRYPT_DECRYPT, expected SIGN_VERIFY/
    );
  });

  it("signs a message with a signature that recovers to the address", async () => {
    const signer = await createAwsSigner({ keyId: "arn:test", client: mockKms() });
    const message = "hello from kms";
    const signature = await signer.account.signMessage!({ message });
    await expect(recoverMessageAddress({ message, signature })).resolves.toBe(ADDR);
  });

  it("normalizes a high-s KMS signature and still recovers", async () => {
    const signer = await createAwsSigner({
      keyId: "arn:test",
      client: mockKms({ forceHighS: true }),
    });
    const message = "high-s path";
    const signature = await signer.account.signMessage!({ message });
    await expect(recoverMessageAddress({ message, signature })).resolves.toBe(ADDR);
  });

  it("signs typed data that recovers to the address", async () => {
    const signer = await createAwsSigner({ keyId: "arn:test", client: mockKms() });
    const typedData = {
      domain: { name: "Test", version: "1", chainId: 1 },
      types: { Mail: [{ name: "content", type: "string" }] },
      primaryType: "Mail",
      message: { content: "gm" },
    } as const;
    const signature = await signer.account.signTypedData!(typedData);
    await expect(recoverTypedDataAddress({ ...typedData, signature })).resolves.toBe(ADDR);
  });

  it("signs an EIP-1559 transaction that recovers to the address", async () => {
    const signer = await createAwsSigner({ keyId: "arn:test", client: mockKms() });
    const serializedTransaction = await signer.account.signTransaction!({
      type: "eip1559",
      chainId: 1,
      to: ADDR,
      value: 1n,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await expect(
      recoverTransactionAddress({ serializedTransaction: serializedTransaction as `0x02${string}` })
    ).resolves.toBe(ADDR);
  });

  it("signs a legacy transaction that recovers to the address", async () => {
    const signer = await createAwsSigner({ keyId: "arn:test", client: mockKms() });
    const serializedTransaction = await signer.account.signTransaction!({
      type: "legacy",
      chainId: 1,
      to: ADDR,
      value: 1n,
      nonce: 0,
      gas: 21000n,
      gasPrice: 1_000_000_000n,
    });
    await expect(
      recoverTransactionAddress({
        serializedTransaction: serializedTransaction as TransactionSerializedLegacy,
      })
    ).resolves.toBe(ADDR);
  });
});
