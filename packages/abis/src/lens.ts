// AaveAdapterLiquidationPreview ABI - read-only helper for estimating liquidation inputs

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
      { name: "debtReserveIds", type: "uint256[]" },
      { name: "debtToCoverAmounts", type: "uint256[]" },
      { name: "wbtcPayment", type: "uint256" },
      { name: "vaultId", type: "bytes32" },
      { name: "amountCollateralToSeize", type: "uint256" },
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
      { name: "debtReserveIds", type: "uint256[]" },
      { name: "debtToCoverAmounts", type: "uint256[]" },
      { name: "wbtcPayment", type: "uint256" },
      { name: "vaultId", type: "bytes32" },
      { name: "amountCollateralToSeize", type: "uint256" },
    ],
    stateMutability: "view",
  },
  // Immutables, read at boot to check this preview belongs to the adapter this bot was configured
  // with. A preview wired to a different Spoke answers every estimate in *its* reserve index space,
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
  // The preview is a view over the same call graph, so its reverts originate in the adapter and
  // spoke it reads through. See `protocolErrors.ts`.
  ...protocolErrorsAbi,
] as const;

/**
 * The preview's own way of saying a position is not liquidatable — `_validateAaveLiquidation`'s
 * `require(healthFactor < HEALTH_FACTOR_LIQUIDATION_THRESHOLD, PositionNotLiquidatable())`.
 *
 * The name of a custom error, so callers match it on the decoded `errorName` rather than on a
 * revert string. It is carried here anyway because it is contract surface in every sense that
 * matters — the indexer's position scan reads it to tell "this borrower is fine" apart from "this
 * deployment cannot answer", and those arrive as the same kind of error. `lens.test.ts` pins it to
 * the contract source, because a bump that merely swapped the error in that guard would otherwise
 * turn every healthy position in the table into a reported fault on the first cycle after deploy.
 */
export const LENS_HEALTHY_POSITION_ERROR = "PositionNotLiquidatable";
