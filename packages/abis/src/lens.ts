// AaveAdapterLens ABI - read-only helper for estimating liquidation inputs

import { protocolErrorsAbi } from "./protocolErrors";

export const lensAbi = [
  {
    type: "function",
    name: "estimateLiquidation",
    inputs: [
      { name: "borrowerProxy", type: "address" },
      { name: "isDirectRedemption", type: "bool" },
    ],
    outputs: [
      { name: "amounts", type: "uint256[]" },
      { name: "wbtcPayment", type: "uint256" },
      { name: "vaults", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "estimateLiquidationWithPriority",
    inputs: [
      { name: "borrowerProxy", type: "address" },
      { name: "priorityLoanTokenIds", type: "uint256[]" },
      { name: "isDirectRedemption", type: "bool" },
    ],
    outputs: [
      { name: "amounts", type: "uint256[]" },
      { name: "wbtcPayment", type: "uint256" },
      { name: "vaults", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
  // Immutables, read at boot to check this Lens belongs to the adapter this bot was configured
  // with. A Lens wired to a different Spoke answers every estimate in *its* reserve index space,
  // which is a mapping error nothing downstream can detect: if the two Spokes happen to list the
  // same number of reserves, the amounts line up and are charged to the wrong tokens.
  {
    type: "function",
    name: "adapter",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "spoke",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // The lens is a view over the same call graph, so its reverts originate in the adapter and
  // spoke it reads through. See `protocolErrors.ts`.
  ...protocolErrorsAbi,
] as const;

/**
 * The lens's own way of saying a position is not liquidatable — `_estimateBaseLiquidation`'s
 * `require(healthFactorInit < HEALTH_FACTOR_LIQUIDATION_THRESHOLD, ...)`.
 *
 * A `require` string, so it has no selector and cannot live in the ABI above: callers match it on
 * the revert *reason*. It is carried here anyway because it is contract surface in every sense that
 * matters — the indexer's position scan reads it to tell "this borrower is fine" apart from "this
 * deployment cannot answer", and those arrive as the same kind of error. `lens.test.ts` pins it to
 * the contract source, because a bump that merely reworded it would otherwise turn every healthy
 * position in the table into a reported fault on the first cycle after deploy.
 */
export const LENS_HEALTHY_POSITION_REVERT = "Position is not undercollateralized";
