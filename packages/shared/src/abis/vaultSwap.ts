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
  // Emergency repay an unprofitable vault (permissionless)
  {
    type: "function",
    name: "emergencyRepayVault",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "wbtcRepaid", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Preview cost with fee breakdown
  {
    type: "function",
    name: "previewWbtcToAcquireVaultWithFees",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [
      { name: "wbtcNeeded", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "interest", type: "uint256" },
      { name: "protocolFee", type: "uint256" },
    ],
    stateMutability: "view",
  },
  // Check if vault is still profitable for arbitrageur
  {
    type: "function",
    name: "isVaultProfitableForArbitrageur",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [
      { name: "isProfitable", type: "bool" },
      { name: "accruedInterest", type: "uint256" },
      { name: "arbitrageurDiscount", type: "uint256" },
      { name: "hubDebt", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;
