import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  type Address,
  type Hex,
  type Signature,
  bytesToHex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  numberToHex,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { toAccount } from "viem/accounts";
import { publicKeyToAddress } from "viem/utils";
import type { Signer } from "./types";

// `@repo/signer` `./aws` adapter — signing via AWS KMS. Named after the *provider*
// (`aws`), like `@repo/secrets`'s `./aws`; KMS is the specific AWS service it uses.
//
// A production signer where the key never leaves AWS KMS: the KMS key is an asymmetric
// `ECC_SECG_P256K1` / `SIGN_VERIFY` key, the Ethereum address is derived from its public
// key, and every signature is produced by a KMS `Sign` call. It plugs into the same
// `Signer` port as the local signer — a service builds its `WalletClient` with
// `signer.account`, and viem's usual assemble→sign→broadcast flow is unchanged.
//
// Two EVM-specific fix-ups are applied to every KMS signature:
//   1. **low-`s` (EIP-2):** KMS may return the high-`s` variant; EVM rejects it, so `s`
//      is normalized into the lower half of the curve order.
//   2. **recovery id:** KMS returns a bare `(r, s)` with no `v`; we recover the address
//      for each candidate parity and keep the one that matches the key's address.

/** Minimal structural view of the AWS `KMSClient` — only the `send` we use. */
export interface KmsClientLike {
  send(command: GetPublicKeyCommand | SignCommand): Promise<{
    // `GetPublicKey` fields
    PublicKey?: Uint8Array;
    KeySpec?: string;
    KeyUsage?: string;
    SigningAlgorithms?: string[];
    // `Sign` field
    Signature?: Uint8Array;
  }>;
}

export interface AwsSignerConfig {
  /** Key id / ARN / alias of an `ECC_SECG_P256K1`, `SIGN_VERIFY` KMS key. */
  keyId: string;
  /**
   * Optional expected address. When set, `createAwsSigner` fails fast at boot if the key
   * derives a different address — a guard against pointing at the wrong key.
   */
  address?: Address;
  /** AWS region; defaults to the SDK's own resolution (env/instance profile). */
  region?: string;
  /** Injectable client — for tests or custom credential/endpoint config. */
  client?: KmsClientLike;
}

/**
 * Build a `Signer` backed by AWS KMS. Async because the address is derived from the KMS
 * public key (a `GetPublicKey` call) at construction time.
 */
export async function createAwsSigner(config: AwsSignerConfig): Promise<Signer> {
  const client: KmsClientLike =
    config.client ??
    (new KMSClient(config.region ? { region: config.region } : {}) as unknown as KmsClientLike);

  const address = await deriveAddress(client, config.keyId);
  if (config.address && !isAddressEqual(config.address, address)) {
    throw new Error(
      `KMS key ${config.keyId} derives address ${address}, not the configured ${config.address}`
    );
  }

  const signHash = async (hash: Hex): Promise<Signature> => {
    const out = await client.send(
      new SignCommand({
        KeyId: config.keyId,
        Message: hexToBytes(hash),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );
    if (!out.Signature) {
      throw new Error(`KMS Sign returned no signature for key ${config.keyId}`);
    }

    let sig = secp256k1.Signature.fromDER(out.Signature);
    if (sig.hasHighS()) sig = sig.normalizeS();
    const r = numberToHex(sig.r, { size: 32 });
    const s = numberToHex(sig.s, { size: 32 });

    for (const yParity of [0, 1] as const) {
      // Set both `yParity` and `v` (27/28): typed-tx serializers and `serializeSignature`
      // read `yParity`, but viem's *legacy* tx serializer reads `signature.v` (it throws
      // on `undefined`). Providing both keeps the signer correct across all tx types.
      const candidate: Signature = { r, s, yParity, v: BigInt(27 + yParity) };
      if (isAddressEqual(await recoverAddress({ hash, signature: candidate }), address)) {
        return candidate;
      }
    }
    throw new Error(`KMS signature for key ${config.keyId} does not recover to ${address}`);
  };

  const account = toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(await signHash(hash));
    },
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signHash(hashTypedData(typedData)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      // Sign the transaction's signing hash, then re-serialize *with* the signature —
      // exactly what viem's local account does internally. `await` covers both a sync
      // `serializeTransaction` and any (hypothetical) async custom serializer.
      const unsigned = await serializer(transaction);
      const signature = await signHash(keccak256(unsigned));
      return serializer(transaction, signature);
    },
  });

  return { address, account };
}

/** Derive the Ethereum address from a KMS secp256k1 public key (DER `SubjectPublicKeyInfo`). */
async function deriveAddress(client: KmsClientLike, keyId: string): Promise<Address> {
  const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!out.PublicKey) {
    throw new Error(`KMS GetPublicKey returned no key for ${keyId}`);
  }
  // Fail fast on a key that cannot produce EVM-valid signatures — otherwise a wrong-curve
  // key (e.g. `ECC_NIST_P256`) or an encrypt-only key would pass address derivation here
  // and only blow up cryptically at first `Sign`. KMS reports these authoritatively.
  if (out.KeySpec && out.KeySpec !== "ECC_SECG_P256K1") {
    throw new Error(`KMS key ${keyId} has KeySpec ${out.KeySpec}, expected ECC_SECG_P256K1`);
  }
  if (out.KeyUsage && out.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(`KMS key ${keyId} has KeyUsage ${out.KeyUsage}, expected SIGN_VERIFY`);
  }
  if (out.SigningAlgorithms && !out.SigningAlgorithms.includes("ECDSA_SHA_256")) {
    throw new Error(
      `KMS key ${keyId} does not support ECDSA_SHA_256 (has ${out.SigningAlgorithms.join(", ")})`
    );
  }
  // For a secp256k1 SPKI the trailing 65 bytes are the uncompressed EC point
  // (`0x04 ‖ X ‖ Y`) — the only part `publicKeyToAddress` needs.
  const der = out.PublicKey;
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) {
    throw new Error(`KMS key ${keyId} is not an uncompressed secp256k1 public key`);
  }
  return publicKeyToAddress(bytesToHex(point));
}
