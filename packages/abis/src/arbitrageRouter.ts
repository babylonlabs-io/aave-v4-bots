// ArbitrageRouter — acquires escrowed vaults with a treasury's WBTC, authorized by a signer that
// holds no funds. See `contracts/ArbitrageRouter.sol` and `contracts/base/SelfCallRelayer.sol`.

import { protocolErrorsAbi } from "./protocolErrors";

export const arbitrageRouterAbi = [
  // The only way to reach `swapWbtcToVault`, which is `onlySelf`. Permissionless: anyone holding a
  // valid (message, signature) pair may submit it and pay the gas.
  {
    type: "function",
    name: "relay",
    inputs: [
      {
        name: "message",
        type: "tuple",
        components: [
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  // Encoded into a relayed `Call`, never called directly — `onlySelf` rejects anything else.
  {
    type: "function",
    name: "swapWbtcToVault",
    inputs: [
      { name: "vaultSwap", type: "address" },
      { name: "vaultId", type: "bytes32" },
      { name: "onBehalfOf", type: "address" },
      { name: "minProfit", type: "uint256" },
      { name: "maxWbtcIn", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // The three immutables. Read at boot and checked against config: a router pointed at a different
  // payer or WBTC fails every acquisition on-chain with nothing to point at the cause.
  {
    type: "function",
    name: "signer",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "payer",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "wbtc",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // Proof that an acquisition happened, whoever submitted it. Load-bearing: `relay` is
  // permissionless, so our own tx reverting no longer proves our money did not move — a third party
  // may have submitted our signed message first. This is how that case is told apart from an
  // ordinary lost race.
  {
    type: "event",
    name: "SwapWbtcToVault",
    inputs: [
      { name: "vaultSwap", type: "address", indexed: true },
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "amountWbtcToAcquire", type: "uint256", indexed: false },
      { name: "amountVault", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  // Router-funded acquisitions forward into BTCVaultSwap, so the whole protocol error surface is
  // reachable through this ABI too. See `protocolErrors.ts`.
  ...protocolErrorsAbi,
] as const;

/** EIP-712 domain name, from `ArbitrageRouter.NAME`. */
export const ARBITRAGE_ROUTER_EIP712_NAME = "ArbitrageRouter";
/** EIP-712 domain version, from `ArbitrageRouter.VERSION`. */
export const ARBITRAGE_ROUTER_EIP712_VERSION = "1.0.0";

/**
 * The typed-data schema `SelfCallRelayer` verifies against.
 *
 * Hand-written on both sides of the wire: the contract builds its digest from
 * `RELAYER_MESSAGE_TYPEHASH`, a keccak of a string literal, and viem derives the same string from
 * this object. Nothing makes them agree at compile time, and a mismatch produces a signature that
 * recovers to the wrong address — which reads on-chain as "invalid signature", not as a schema bug.
 * `arbitrageRouter.test.ts` pins the derived string against the Solidity literal for that reason.
 *
 * Member order matters: EIP-712 encodes fields in declaration order.
 */
export const RELAYER_MESSAGE_TYPES = {
  RelayerMessage: [
    { name: "calls", type: "Call[]" },
    { name: "deadline", type: "uint256" },
  ],
  Call: [
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
  ],
} as const;

/**
 * The EIP-712 domain for one deployed router.
 *
 * `verifyingContract` binds a signature to a single router, and `chainId` to a single chain — the
 * only replay protection this scheme has, since `SelfCallRelayer` carries no nonce.
 */
export function arbitrageRouterDomain(input: {
  chainId: number;
  verifyingContract: `0x${string}`;
}) {
  return {
    name: ARBITRAGE_ROUTER_EIP712_NAME,
    version: ARBITRAGE_ROUTER_EIP712_VERSION,
    chainId: input.chainId,
    verifyingContract: input.verifyingContract,
  } as const;
}
