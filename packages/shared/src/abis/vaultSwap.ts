// VaultSwap ABI - methods used by liquidator and arbitrageur bots

export const vaultSwapAbi = [
  // Liquidator
  {
    type: "function",
    name: "swapVaultForWbtc",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "wbtcOut", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Arbitrageur
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
