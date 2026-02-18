// AaveIntegrationController ABI - methods used by liquidator and arbitrageur bots

export const controllerAbi = [
  // Liquidator
  {
    type: "function",
    name: "BTC_VAULT_CORE_SPOKE",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "liquidateCorePosition",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "btcRedeemKey", type: "bytes32" },
    ],
    outputs: [{ name: "seizedAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getUserOfProxy",
    inputs: [{ name: "proxy", type: "address" }],
    outputs: [{ name: "user", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "VaultOwnershipTransferred",
    inputs: [
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  // Arbitrageur
  {
    type: "function",
    name: "arbitrageurRedeem",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getVaultOwner",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }],
    stateMutability: "view",
  },
] as const;
