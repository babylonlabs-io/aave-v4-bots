// AaveAdapter ABI - methods used by liquidator and arbitrageur bots

export const adapterAbi = [
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
      { name: "minVaultBtcOut", type: "uint256" },
      { name: "numVaultsToLiquidate", type: "uint256" },
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
] as const;
