// AaveAdapter ABI - methods used by liquidator and arbitrageur bots

import { protocolErrorsAbi } from "./protocolErrors";

export const adapterAbi = [
  // Liquidator
  {
    type: "function",
    name: "BTC_VAULT_CORE_SPOKE",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // Both liquidation entry points seize exactly one vault — the head of the borrower's ordered
  // list — and cover the debt of the one reserve the borrower owes. `maxExitBtcPayment` caps the
  // WBTC the adapter pulls from the caller on top of that debt, so an estimate that went stale
  // between the read and the send is refused on-chain instead of charged. It covers the fee and
  // the fairness payment on `liquidate`, and the fairness payment alone on `liquidateWithLLP`,
  // where the LLP pays the fee.
  {
    type: "function",
    name: "liquidate",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "debtReserveId", type: "uint256" },
      { name: "debtToCover", type: "uint256" },
      { name: "maxExitBtcPayment", type: "uint256" },
      { name: "directBtcRedeemKey", type: "bytes32" },
    ],
    outputs: [
      { name: "vaultIdLiquidated", type: "bytes32" },
      { name: "amountCollateralLiquidated", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "liquidateWithLLP",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "llp", type: "address" },
      { name: "debtReserveId", type: "uint256" },
      { name: "debtToCover", type: "uint256" },
      { name: "maxExitBtcPayment", type: "uint256" },
      {
        name: "requestedTokens",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "vaultIdLiquidated", type: "bytes32" },
      { name: "amountCollateralLiquidated", type: "uint256" },
      {
        name: "payouts",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "VaultOwnershipChanged",
    inputs: [
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "UserProxyCreated",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "proxy", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  // A borrower's position. `totalCollateralBTC` goes to 0 once the position is fully liquidated —
  // the liquidation engine reads it after a reverted `liquidate` to tell a lost race (a competitor
  // already cleared the position) from a genuine failure.
  {
    type: "function",
    name: "getPosition",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        name: "position",
        type: "tuple",
        components: [
          { name: "vaultIds", type: "bytes32[]" },
          { name: "totalCollateralBTC", type: "uint256" },
          { name: "proxyContract", type: "address" },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Reverts from anywhere in the liquidation call graph — the adapter delegates into the
  // registries, the position account, and the Aave spoke, and any of them can be the one that
  // actually reverted. See `protocolErrors.ts`.
  ...protocolErrorsAbi,
] as const;
