export const vaultSwapAbi = [
  {
    type: "function",
    name: "swapWbtcForVault",
    inputs: [
      { name: "vaultId", type: "bytes32" },
      { name: "maxWbtcIn", type: "uint256" },
    ],
    outputs: [{ name: "wbtcPaid", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;
