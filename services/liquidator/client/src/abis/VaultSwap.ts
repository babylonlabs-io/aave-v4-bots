export const vaultSwapAbi = [
  {
    type: "function",
    name: "swapVaultForWbtc",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "wbtcOut", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;
