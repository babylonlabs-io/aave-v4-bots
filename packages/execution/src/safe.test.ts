import { safeAbi } from "@repo/abis";
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  type ProposalPayload,
  buildSafeExecution,
  computeSafeTxHash,
  decodeExecTransaction,
  defaultSafeTxParams,
  encodeExecTransaction,
  encodeSafeSignatures,
  safeTxTypedData,
} from "./index";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const inner: ProposalPayload = {
  chainId: 8453,
  to: TARGET,
  data: "0xdeadbeef",
  value: "0",
};

describe("defaultSafeTxParams (v1 zero-gas/refund policy)", () => {
  it("zeroes every gas + refund field and uses CALL", () => {
    expect(defaultSafeTxParams(7)).toEqual({
      safeNonce: 7,
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO,
      refundReceiver: ZERO,
    });
  });
});

describe("computeSafeTxHash", () => {
  const params = defaultSafeTxParams(5);

  // The authoritative offline check: recompute the Safe EIP-712 hash a SECOND, independent way — the
  // canonical `keccak256(0x19 01 ++ domainSeparator ++ safeTxStructHash)` — and require it to equal
  // what `computeSafeTxHash` (viem's `hashTypedData`) produces. Two implementations agreeing catches
  // a wrong type string, field order, or domain shape. (The on-chain `getTransactionHash` equality is
  // the e2e's job, against a real Safe.)
  it("matches a hand-rolled canonical Safe EIP-712 computation", () => {
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(uint256 chainId,address verifyingContract)")),
          BigInt(inner.chainId),
          getAddress(SAFE),
        ]
      )
    );
    const safeTxTypehash = keccak256(
      toHex(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
      )
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "uint8" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
        ],
        [
          safeTxTypehash,
          getAddress(inner.to),
          BigInt(inner.value),
          keccak256(inner.data),
          params.operation,
          BigInt(params.safeTxGas),
          BigInt(params.baseGas),
          BigInt(params.gasPrice),
          getAddress(params.gasToken),
          getAddress(params.refundReceiver),
          BigInt(params.safeNonce),
        ]
      )
    );
    const expected = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex);

    expect(computeSafeTxHash({ inner, params, safe: SAFE, chainId: inner.chainId })).toBe(expected);
  });

  it("is deterministic and changes with the nonce", () => {
    const h1 = computeSafeTxHash({
      inner,
      params: defaultSafeTxParams(1),
      safe: SAFE,
      chainId: 8453,
    });
    const h2 = computeSafeTxHash({
      inner,
      params: defaultSafeTxParams(1),
      safe: SAFE,
      chainId: 8453,
    });
    const h3 = computeSafeTxHash({
      inner,
      params: defaultSafeTxParams(2),
      safe: SAFE,
      chainId: 8453,
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("changes with the chain id (domain is chain-bound)", () => {
    const a = computeSafeTxHash({ inner, params, safe: SAFE, chainId: 1 });
    const b = computeSafeTxHash({ inner, params, safe: SAFE, chainId: 8453 });
    expect(a).not.toBe(b);
  });

  it("hashes the typed data viem would sign (sign == hash source)", () => {
    // safeTxTypedData is the single object used for both signing and hashing.
    const td = safeTxTypedData({ inner, params, safe: SAFE, chainId: 8453 });
    expect(td.primaryType).toBe("SafeTx");
    expect(td.message.nonce).toBe(5n);
  });
});

describe("buildSafeExecution", () => {
  it("produces the full envelope: policy params + version + hash", () => {
    const exec = buildSafeExecution({
      inner,
      safe: SAFE,
      chainId: 8453,
      safeNonce: 9,
      safeVersion: "1.4.1",
    });
    expect(exec).toMatchObject({
      safeNonce: 9,
      operation: 0,
      gasPrice: "0",
      refundReceiver: ZERO,
      safeVersion: "1.4.1",
    });
    expect(exec.safeTxHash).toBe(
      computeSafeTxHash({ inner, params: defaultSafeTxParams(9), safe: SAFE, chainId: 8453 })
    );
  });
});

describe("encodeSafeSignatures", () => {
  it("concatenates owner sigs sorted by address ascending", () => {
    const hi = {
      owner: "0xbb00000000000000000000000000000000000000" as Address,
      signature: "0xbbbb" as Hex,
    };
    const lo = {
      owner: "0xaa00000000000000000000000000000000000000" as Address,
      signature: "0xaaaa" as Hex,
    };
    expect(encodeSafeSignatures([hi, lo])).toBe("0xaaaabbbb");
    expect(encodeSafeSignatures([lo, hi])).toBe("0xaaaabbbb");
  });
});

describe("encodeExecTransaction / decodeExecTransaction round-trip", () => {
  it("decodes back the exact inner call and params (nonce is not in calldata)", () => {
    const params = defaultSafeTxParams(3);
    const signatures = "0xabcd" as Hex;
    const data = encodeExecTransaction({ inner, params, signatures });

    const decoded = decodeExecTransaction(data);
    expect(decoded.inner).toEqual({ to: getAddress(TARGET), value: "0", data: inner.data });
    expect(decoded.signatures).toBe(signatures);
    expect(decoded.params).toEqual({ ...params, safeNonce: -1 }); // nonce absent ⇒ sentinel
  });

  it("throws on non-execTransaction calldata", () => {
    const notExec = encodeFunctionData({ abi: safeAbi, functionName: "getThreshold" });
    expect(() => decodeExecTransaction(notExec)).toThrow(/execTransaction/);
  });
});
