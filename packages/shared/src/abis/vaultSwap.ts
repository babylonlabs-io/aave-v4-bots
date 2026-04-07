// VaultSwap ABI - methods used by arbitrageur bot

export const vaultSwapAbi = [
  // Acquire vault (redemption happens atomically inside)
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
  // Repay interest on an escrowed vault
  {
    type: "function",
    name: "repayVaultInterest",
    inputs: [
      { name: "vaultId", type: "bytes32" },
      { name: "wbtcToRepay", type: "uint256" },
    ],
    outputs: [{ name: "wbtcPaid", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Batch preview of escrowed vaults with full debt/profitability info
  {
    type: "function",
    name: "previewEscrowedVaults",
    inputs: [{ name: "_escrowedVaults", type: "bytes32[]" }],
    outputs: [
      {
        name: "vaults",
        type: "tuple[]",
        components: [
          { name: "vaultId", type: "bytes32" },
          { name: "amountVault", type: "uint256" },
          { name: "amountDebt", type: "uint256" },
          { name: "amountInterest", type: "uint256" },
          { name: "amountFee", type: "uint256" },
          { name: "amountWbtcToAcquire", type: "uint256" },
          { name: "isProfitable", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;
