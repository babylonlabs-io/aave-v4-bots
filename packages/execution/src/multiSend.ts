import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodePacked,
  getAddress,
  keccak256,
  size,
} from "viem";
import { type ContractCall, encodeCall } from "./txSender";

// Safe's MultiSendCallOnly v1.5.0, the one contract a SafeTx may DELEGATECALL. It runs several
// calls from the Safe in one transaction and reverts on any nested DELEGATECALL, so the Safe's own
// storage stays out of reach. Canonical address and runtime code hash from safe-global/safe-deployments.
export const MULTI_SEND_CALL_ONLY: Address = "0xA83c336B20401Af773B6219BA5027174338D1836";
export const MULTI_SEND_CALL_ONLY_CODE_HASH: Hex =
  "0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663";

export const multiSendCallOnlyAbi = [
  {
    type: "function",
    name: "multiSend",
    stateMutability: "payable",
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
  },
] as const;

/** True when `to` is the pinned MultiSendCallOnly, the only target a SafeTx may DELEGATECALL. */
export function isMultiSendCallOnly(to: Address): boolean {
  return getAddress(to) === MULTI_SEND_CALL_ONLY;
}

/**
 * One `multiSend` call that runs `calls` in order, each as a CALL with zero value. MultiSend's
 * packed layout per call: operation (uint8), to (address), value (uint256), data length (uint256),
 * data.
 */
export function buildMultiSendCall(calls: readonly ContractCall[]): ContractCall {
  if (calls.length === 0) throw new Error("multiSend needs at least one call");
  const packed = concatHex(
    calls.map((call) => {
      const { to, data } = encodeCall(call);
      return encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, to, 0n, BigInt(size(data)), data]
      );
    })
  );
  return {
    address: MULTI_SEND_CALL_ONLY,
    abi: multiSendCallOnlyAbi,
    functionName: "multiSend",
    args: [packed],
  };
}

/**
 * The runtime code at the pinned address, after checking it is the canonical MultiSendCallOnly.
 * Throws when the chain has other code there or none, so nothing is ever proposed against it.
 */
export async function readMultiSendCallOnlyCode(publicClient: PublicClient): Promise<Hex> {
  const code = await publicClient.getCode({ address: MULTI_SEND_CALL_ONLY });
  if (!code || code === "0x" || keccak256(code) !== MULTI_SEND_CALL_ONLY_CODE_HASH) {
    throw new Error(
      `${MULTI_SEND_CALL_ONLY} is not Safe's MultiSendCallOnly v1.5.0 on this chain (code hash ${code && code !== "0x" ? keccak256(code) : "none"}) — refusing to batch through it`
    );
  }
  return code;
}
