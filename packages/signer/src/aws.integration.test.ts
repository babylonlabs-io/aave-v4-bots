import { recoverMessageAddress, recoverTransactionAddress } from "viem";
import { describe, expect, it } from "vitest";
import { createAwsSigner } from "./aws";

// Opt-in integration test that hits **real AWS KMS** (the unit test in `aws.test.ts` uses a
// mock). It runs only when a real key is configured; otherwise the whole block is skipped,
// so `pnpm test` stays offline by default.
//
// To run against a real key:
//   export KMS_E2E_KEY_ID=arn:aws:kms:us-east-1:123:key/abc   # ECC_SECG_P256K1, SIGN_VERIFY
//   export AWS_REGION=us-east-1                                # (or rely on SDK resolution)
//   # plus AWS credentials the SDK can find (env / profile / instance role)
//   pnpm --filter @repo/signer test aws.integration
//
// Each `it` performs live KMS `GetPublicKey` + `Sign` calls (small cost).

const KEY_ID = process.env.KMS_E2E_KEY_ID;
const REGION = process.env.AWS_REGION;
const TIMEOUT = 30_000;

describe.runIf(!!KEY_ID)("createAwsSigner (integration — real AWS KMS)", () => {
  it(
    "derives an address and signs a message that recovers to it",
    async () => {
      const signer = await createAwsSigner({ keyId: KEY_ID as string, region: REGION });
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

      const message = `@repo/signer kms integration ${Date.now()}`;
      const signature = await signer.account.signMessage!({ message });
      await expect(recoverMessageAddress({ message, signature })).resolves.toBe(signer.address);
    },
    TIMEOUT
  );

  it(
    "signs an EIP-1559 transaction that recovers to the address",
    async () => {
      const signer = await createAwsSigner({ keyId: KEY_ID as string, region: REGION });
      const serializedTransaction = await signer.account.signTransaction!({
        type: "eip1559",
        chainId: 1,
        to: signer.address,
        value: 0n,
        nonce: 0,
        gas: 21000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      await expect(
        recoverTransactionAddress({
          serializedTransaction: serializedTransaction as `0x02${string}`,
        })
      ).resolves.toBe(signer.address);
    },
    TIMEOUT
  );

  it(
    "fails fast when the configured address does not match the key",
    async () => {
      await expect(
        createAwsSigner({
          keyId: KEY_ID as string,
          region: REGION,
          address: "0x000000000000000000000000000000000000dEaD",
        })
      ).rejects.toThrow(/does not match|not the configured/);
    },
    TIMEOUT
  );
});
