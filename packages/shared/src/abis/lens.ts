// AaveIntegrationLens ABI - read-only helper for estimating liquidation inputs

export const lensAbi = [
  {
    type: "function",
    name: "estimateLiquidation",
    inputs: [
      { name: "borrowerProxy", type: "address" },
      { name: "isDirectRedemption", type: "bool" },
    ],
    outputs: [
      {
        name: "inputs",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
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
      {
        name: "inputs",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      { name: "vaults", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
] as const;
