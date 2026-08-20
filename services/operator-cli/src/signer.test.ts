import { computeSafeTxHash, defaultSafeTxParams } from "@repo/execution";
import type { Address, Chain, Hex, PublicClient, Transport } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createSafeOperatorSigner } from "./signer";

// The claim path is where a SafeTx hash is minted, and the recorded hash is what every later "did
// this already execute?" scan looks for. If the Safe hashes the same transaction differently — a
// version older than v1.3.0 leaves `chainId` out of its EIP-712 domain — the recorded hash appears
// in no event the Safe will ever emit, `release` frees the claim, and the action can execute twice.

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const CHAIN_ID = 31337;
const SAFE_NONCE = 7;
const inner = {
  chainId: CHAIN_ID,
  to: "0x2222222222222222222222222222222222222222" as Address,
  data: "0xdeadbeef" as Hex,
  value: "0",
};

/** The hash a Safe that agrees with us would return. */
const agreeing = computeSafeTxHash({
  inner,
  params: defaultSafeTxParams(SAFE_NONCE),
  safe: SAFE,
  chainId: CHAIN_ID,
});

const signer = (over: { hash?: Hex | Error; version?: string | Error } = {}) => {
  const publicClient = {
    getBlockNumber: vi.fn(async () => 500n),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "nonce") return BigInt(SAFE_NONCE);
      if (functionName === "VERSION") {
        if (over.version instanceof Error) throw over.version;
        return over.version ?? "1.4.1";
      }
      if (functionName === "getTransactionHash") {
        if (over.hash instanceof Error) throw over.hash;
        return over.hash ?? agreeing;
      }
      throw new Error(`unexpected read: ${functionName}`);
    }),
  } as unknown as PublicClient;

  return createSafeOperatorSigner({
    safe: SAFE,
    owners: [],
    publicClient,
    chain: { id: CHAIN_ID } as Chain,
    transport: (() => {}) as unknown as Transport,
    chainId: CHAIN_ID,
  });
};

/** `buildEnvelope` is `SafeEnvelope | undefined` because the EOA signer returns none; a Safe must. */
const built = async (s: ReturnType<typeof signer>) => {
  const envelope = await s.buildEnvelope(inner);
  if (!envelope) throw new Error("safe custody must produce an envelope");
  return envelope;
};

describe("createSafeOperatorSigner — buildEnvelope", () => {
  it("records the envelope when the Safe hashes it the same way", async () => {
    const envelope = await built(signer());

    expect(envelope.safeTxHash).toBe(agreeing);
    expect(envelope).toMatchObject({ safeNonce: SAFE_NONCE, claimBlock: 500 });
  });

  it("records the version the contract reports, not one it was told", async () => {
    expect(await signer({ version: "1.3.0" }).buildEnvelope(inner)).toMatchObject({
      safeVersion: "1.3.0",
    });
  });

  // Metadata, not a guard — its absence must not stop a Safe whose hash we have verified.
  it("still builds when the Safe will not say what version it is", async () => {
    const envelope = await built(signer({ version: new Error("no VERSION") }));

    expect(envelope.safeVersion).toBe("unknown");
    expect(envelope.safeTxHash).toBe(agreeing);
  });

  // The reported case: a Safe older than v1.3.0 answers `getThreshold` and `nonce` exactly like a
  // modern one, so nothing else in the custody checks can tell them apart.
  it("refuses to record an envelope the Safe hashes differently", async () => {
    const different = `0x${"c".repeat(64)}` as Hex;

    await expect(
      signer({ hash: different, version: "1.2.0" }).buildEnvelope(inner)
    ).rejects.toThrow(/hashes this SafeTx as 0xcccc/);
  });

  it("names the version it was told, so the cause is obvious", async () => {
    const different = `0x${"c".repeat(64)}` as Hex;

    await expect(
      signer({ hash: different, version: "1.2.0" }).buildEnvelope(inner)
    ).rejects.toThrow(/reported version 1\.2\.0/);
  });

  // Fail closed: a contract that will not tell us its hash is one we cannot check, and an unchecked
  // envelope is exactly what this guard exists to prevent.
  it("refuses when the Safe cannot be asked at all", async () => {
    await expect(
      signer({ hash: new Error("execution reverted") }).buildEnvelope(inner)
    ).rejects.toThrow(/execution reverted/);
  });
});
