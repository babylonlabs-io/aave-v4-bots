// AaveAdapterLens ABI - read-only helper for estimating liquidation inputs

import { protocolErrorsAbi } from "./protocolErrors";

export const lensAbi = [
  // `amounts` holds one debt amount per reserve, indexed by reserve id. `vaults` is the prefix of
  // the borrower's ordered vault list the liquidation seizes.
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
  // Immutables, read at boot to check this lens belongs to the adapter this bot was configured
  // with. A lens wired to a different Spoke answers every estimate in *its* reserve index space,
  // and the reserve ids it returns then name this Spoke's reserves — charging each amount to the
  // wrong token, with nothing downstream able to detect it.
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
 * The lens's own way of saying a position is not liquidatable — `_simulateAaveLiquidation`'s
 * `require(healthFactorInit < HEALTH_FACTOR_LIQUIDATION_THRESHOLD, "Position is not undercollateralized")`.
 *
 * A `require` string, so it decodes as `Error(string)` and callers match it on the decoded reason.
 * It is carried here because it is contract surface in every sense that matters — the indexer's
 * position scan reads it to tell "this borrower is fine" apart from "this deployment cannot
 * answer", and those arrive as the same kind of error. `lens.test.ts` pins it to the contract
 * source, because a bump that merely reworded that guard would otherwise turn every healthy
 * position in the table into a reported fault on the first cycle after deploy.
 */
export const LENS_HEALTHY_POSITION_REASON = "Position is not undercollateralized";
