import { safeAbi } from "@repo/abis";
import {
  type Address,
  type Hex,
  type TypedDataDomain,
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
} from "viem";
import type { ProposalPayload } from "./index";

// The pure (chain-free) half of MANUAL `safe` custody: wrap a proposal's INNER call into a SafeTx,
// compute the EIP-712 `safeTxHash` the owners sign, and encode/decode `execTransaction`. The
// operator-cli composes these with chain reads (the Safe's nonce/threshold) and signing; the bot's
// reconcile only reads back the `Execution*` event. Hand-rolled on viem's `hashTypedData` + ABI
// codecs — the Safe-specific knowledge is just the
// `SafeTx` type layout, the domain, and the signature-concatenation rule.
//
// **Supported Safe versions: v1.3.0+** — their EIP-712 domain is `{chainId, verifyingContract}`.
// Pre-1.3.0 Safes omit `chainId` from the domain and are out of scope.

/**
 * The Safe-specific fields wrapping a proposal's inner call into a SafeTx. Decimal strings, so the
 * whole thing is JSON-serializable — structurally the non-hash fields of `@repo/persistence`'s
 * `SafeEnvelope` (kept decoupled; the engine/CLI, which see both, bridge them).
 */
export interface SafeTxParams {
  /** The Safe's on-chain nonce this SafeTx consumes. */
  safeNonce: number;
  /** `0` = CALL, `1` = DELEGATECALL. */
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
}

/** A built SafeTx execution: its params, the Safe version, and the `safeTxHash` owners sign. */
export interface SafeExecution extends SafeTxParams {
  safeVersion: string;
  safeTxHash: Hex;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * The v1 gas/refund policy: `operation = CALL`, and **no Safe-level refund** — every gas/refund field
 * zeroed. A nonzero `refundReceiver`/`gasPrice` moves value out of the Safe on each execution, so
 * `operator-cli`'s `confirm` rejects any deviation from this. Only the nonce varies per SafeTx.
 */
export function defaultSafeTxParams(safeNonce: number): SafeTxParams {
  return {
    safeNonce,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
  };
}

/** The EIP-712 typed-data of a SafeTx — the single source for both hashing and signing, so an owner
 *  never signs something other than what `computeSafeTxHash` commits to. */
export function safeTxTypedData(args: {
  inner: ProposalPayload;
  params: SafeTxParams;
  safe: Address;
  chainId: number;
}) {
  const { inner, params, safe, chainId } = args;
  const domain: TypedDataDomain = { chainId, verifyingContract: getAddress(safe) };
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  } as const;
  const message = {
    to: getAddress(inner.to),
    value: BigInt(inner.value),
    data: inner.data,
    operation: params.operation,
    safeTxGas: BigInt(params.safeTxGas),
    baseGas: BigInt(params.baseGas),
    gasPrice: BigInt(params.gasPrice),
    gasToken: getAddress(params.gasToken),
    refundReceiver: getAddress(params.refundReceiver),
    nonce: BigInt(params.safeNonce),
  };
  return { domain, types, primaryType: "SafeTx" as const, message };
}

/** The EIP-712 `safeTxHash` an owner signs. A test cross-checks this against the Safe's own on-chain
 *  `getTransactionHash(...)` (see `@repo/abis` `safeAbi`), so the domain/type layout cannot drift. */
export function computeSafeTxHash(args: {
  inner: ProposalPayload;
  params: SafeTxParams;
  safe: Address;
  chainId: number;
}): Hex {
  return hashTypedData(safeTxTypedData(args));
}

/**
 * Build the full SafeTx execution for a proposal's inner call at `safeNonce`, applying the v1
 * zero-gas/refund policy and computing the `safeTxHash`. This is what `claimProposal` persists as the
 * `SafeEnvelope`, fixed before owners sign so the signed hash is exactly what executes.
 */
export function buildSafeExecution(args: {
  inner: ProposalPayload;
  safe: Address;
  chainId: number;
  safeNonce: number;
  safeVersion: string;
}): SafeExecution {
  const params = defaultSafeTxParams(args.safeNonce);
  const safeTxHash = computeSafeTxHash({
    inner: args.inner,
    params,
    safe: args.safe,
    chainId: args.chainId,
  });
  return { ...params, safeVersion: args.safeVersion, safeTxHash };
}

/**
 * Concatenate owner signatures into the `bytes` Safe's `execTransaction` expects: each a 65-byte
 * `(r,s,v)`, **sorted by owner address ascending** (the order the Safe validates in). A threshold's
 * worth must be supplied.
 */
export function encodeSafeSignatures(sigs: Array<{ owner: Address; signature: Hex }>): Hex {
  const ordered = [...sigs].sort((a, b) =>
    getAddress(a.owner).toLowerCase() < getAddress(b.owner).toLowerCase() ? -1 : 1
  );
  return concatHex(ordered.map((s) => s.signature));
}

/** Encode the `execTransaction` calldata that broadcasts a SafeTx with its collected `signatures`. */
export function encodeExecTransaction(args: {
  inner: ProposalPayload;
  params: SafeTxParams;
  signatures: Hex;
}): Hex {
  const { inner, params, signatures } = args;
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      getAddress(inner.to),
      BigInt(inner.value),
      inner.data,
      params.operation,
      BigInt(params.safeTxGas),
      BigInt(params.baseGas),
      BigInt(params.gasPrice),
      getAddress(params.gasToken),
      getAddress(params.refundReceiver),
      signatures,
    ],
  });
}

/** The inner call + Safe params recovered from an on-chain `execTransaction` — what `confirm` checks
 *  a Safe-UI/hardware-signed tx against the persisted proposal + envelope. */
export interface DecodedExecTransaction {
  inner: { to: Address; value: string; data: Hex };
  params: SafeTxParams;
  signatures: Hex;
}

/** Decode `execTransaction` calldata back to its inner call + params. Throws if `data` is not an
 *  `execTransaction` call. `safeNonce` is not in the calldata, so it comes back `-1` (a sentinel):
 *  the caller matches the rest against the persisted envelope and re-derives the nonce from it. */
export function decodeExecTransaction(data: Hex): DecodedExecTransaction {
  const { functionName, args } = decodeFunctionData({ abi: safeAbi, data });
  if (functionName !== "execTransaction") {
    throw new Error(`expected execTransaction calldata, got ${functionName}`);
  }
  const [
    to,
    value,
    callData,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    signatures,
  ] = args;
  return {
    inner: { to: getAddress(to), value: value.toString(), data: callData },
    params: {
      safeNonce: -1,
      operation: Number(operation) as 0 | 1,
      safeTxGas: safeTxGas.toString(),
      baseGas: baseGas.toString(),
      gasPrice: gasPrice.toString(),
      gasToken: getAddress(gasToken),
      refundReceiver: getAddress(refundReceiver),
    },
    signatures,
  };
}
