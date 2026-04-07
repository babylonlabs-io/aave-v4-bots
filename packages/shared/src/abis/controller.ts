// AaveIntegrationAdapter ABI - methods used by liquidator and arbitrageur bots

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
    name: "liquidate",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "directBtcRedeemKey", type: "bytes32" },
      { name: "amounts", type: "uint256[]" },
      { name: "priorityOrder", type: "uint256[]" },
    ],
    outputs: [{ name: "vaultIds", type: "bytes32[]" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "liquidateWithLLP",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "llp", type: "address" },
      { name: "amounts", type: "uint256[]" },
      { name: "priorityOrder", type: "uint256[]" },
      {
        name: "requestedTokens",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "vaultIds", type: "bytes32[]" }],
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
] as const;
