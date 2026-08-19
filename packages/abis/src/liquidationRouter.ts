// LiquidationRouter ABI — the flash-funded liquidation path (contracts/LiquidationRouter.sol).
//
// Transcribed from the compiled artifact (out/LiquidationRouter.sol/LiquidationRouter.json), not
// hand-written: the tuple component order IS the ABI encoding, so a re-ordered field would encode a
// structurally valid but wrong call. `pnpm --filter @repo/abis test` re-checks this file against the
// artifact whenever the contracts are rebuilt.

import type { ContractErrorArgs, ContractFunctionArgs } from "viem";

import { protocolErrorsAbi } from "./protocolErrors";

export const liquidationRouterAbi = [
  // The entry point. `flashDatas` order is load-bearing: venues are set up and drawn in this order
  // and repaid in reverse as the callbacks unwind.
  {
    type: "function",
    name: "liquidate",
    inputs: [
      {
        name: "liquidationData",
        type: "tuple",
        components: [
          { name: "borrower", type: "address" },
          { name: "minWbtcProfit", type: "uint256" },
        ],
      },
      {
        name: "flashDatas",
        type: "tuple[]",
        components: [
          { name: "venueType", type: "uint8" },
          { name: "venueAddress", type: "address" },
          { name: "token", type: "address" },
          { name: "swapData", type: "bytes" },
        ],
      },
      {
        name: "swapDatas",
        type: "tuple[]",
        components: [
          { name: "dexAggRouter", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "wbtcProfit", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Only permitted caller, and the recipient of every swept reserve balance. Immutable on-chain, so
  // a router is bound to one executing identity for life.
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // Read at boot to check the deployed router agrees with our configured WBTC.
  {
    type: "function",
    name: "wbtc",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // The probe's revert. `liquidate` with `minWbtcProfit = MIN_PROFIT_REVERT_TAG` runs the whole
  // liquidation and then throws this deliberately, which is the only way to learn the realised WBTC
  // and the exact venue debts. Without this entry viem cannot decode it and the probe is useless —
  // it would surface as an unknown 4-byte selector.
  {
    type: "error",
    name: "BelovedError",
    inputs: [
      { name: "netWbtcBeforePayment", type: "uint256" },
      {
        name: "debts",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "venue", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
  },
  // Everything the adapter, registries and spoke this router calls can raise. `BelovedError` is
  // restated above rather than left to this union alone, because the probe depends on it and the
  // union is regenerated from whichever contracts the generator is pointed at. Re-declaring an
  // entry the union also carries is harmless — decoding matches on selector and takes the first.
  // See `protocolErrors.ts`.
  ...protocolErrorsAbi,
] as const;

// The argument structs, derived from the ABI above rather than restated. Hand-writing them would
// reintroduce exactly the drift this package exists to prevent — a mirror of `Types.FlashData` that
// compiles perfectly while encoding the wrong bytes. Because these are projections of the ABI, a
// change there is a compile error at every use site instead of a runtime surprise.

type LiquidateArgs = ContractFunctionArgs<typeof liquidationRouterAbi, "nonpayable", "liquidate">;

/** `Types.LiquidationData` — the borrower, and the WBTC floor below which the call reverts. */
export type LiquidationData = LiquidateArgs[0];

/** `Types.FlashData` — one flash venue to draw from. Order matters; see `liquidate`. */
export type FlashData = LiquidateArgs[1][number];

/** `Types.SwapData` — a dex-aggregator call. Empty for flash-swap-funded liquidations. */
export type SwapData = LiquidateArgs[2][number];

/** `Types.VenueDebt` — what one venue wants back, as reported by the `BelovedError` probe. */
export type VenueDebt = ContractErrorArgs<typeof liquidationRouterAbi, "BelovedError">[1][number];

/// `Types.VenueType` — the on-chain enum, whose ordinal is what `FlashData.venueType` carries.
export const VenueType = {
  AaveV3: 0,
  Morpho: 1,
  UniswapV4FlashSwap: 2,
  UniswapV4FlashLoan: 3,
} as const;

export type VenueTypeName = keyof typeof VenueType;
export type VenueTypeValue = (typeof VenueType)[VenueTypeName];

/// The sentinel `minWbtcProfit` that turns `liquidate` into the read-only probe described above.
/// `type(uint256).max` — never use it on a transaction meant to land.
export const MIN_PROFIT_REVERT_TAG = (1n << 256n) - 1n;
