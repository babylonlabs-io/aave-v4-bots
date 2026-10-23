// Read-side ABIs for the flash venues `LiquidationRouter` borrows from — what the bot calls to price
// a venue before choosing it, never to borrow. Hand-maintained subsets. The functions of the ones
// this repo compiles (`IV4Quoter`, `UniswapV4SwapVenue`) are pinned in `artifacts.test.ts`, and the
// quoter's errors to their Solidity source in `flashVenues.test.ts`. StateView and the Aave v3 pool
// are not built here, so nothing pins them.

import { type Hex, keccak256 } from "viem";
import { type PoolKey, encodePoolKey } from "./uniswapV4";

/**
 * `PoolId` — `keccak256(abi.encode(poolKey))`, the id the pool manager and StateView index pools by.
 * `PoolKey` is five static words, so its ABI encoding is exactly the memory the contract hashes.
 */
export function poolIdOf(poolKey: PoolKey): Hex {
  return keccak256(encodePoolKey(poolKey));
}

/**
 * UniswapV4 `V4Quoter`.
 *
 * `quoteExactOutputSingle` is not a view: it runs the swap inside the pool manager and reverts with
 * the result, so it is called through a simulation. Any failure other than its own quote comes back
 * wrapped as `UnexpectedRevertBytes(inner)` — including `NotEnoughLiquidity`, which is why both
 * errors are declared.
 */
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "error",
    name: "UnexpectedRevertBytes",
    inputs: [{ name: "revertData", type: "bytes" }],
  },
  {
    type: "error",
    name: "NotEnoughLiquidity",
    inputs: [{ name: "poolId", type: "bytes32" }],
  },
] as const;

/** UniswapV4 `StateView` — pool state by id, without going through the pool manager's extsload. */
export const v4StateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** `UniswapV4SwapVenue` (ours) — the pool manager it swaps against. */
export const uniswapV4SwapVenueAbi = [
  {
    type: "function",
    name: "uniV4PoolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Aave v3 `Pool`.
 *
 * `getReserveData` declares only the leading fields of the reserve struct, up to `aTokenAddress`.
 * Those are the ones every v3 release lays out the same way; later fields were renamed or retired
 * between releases. The struct is all static words, so decoding a prefix reads the same bytes.
 */
export const aaveV3PoolAbi = [
  {
    type: "function",
    name: "FLASHLOAN_PREMIUM_TOTAL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getVirtualUnderlyingBalance",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
        ],
      },
    ],
  },
] as const;
