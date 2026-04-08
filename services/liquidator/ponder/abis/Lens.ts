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
      { name: "vaults", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
] as const;
