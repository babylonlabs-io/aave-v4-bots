export const aaveIntegrationControllerAbi = [
  // Liquidation function
  {
    type: "function",
    name: "liquidateCorePosition",
    inputs: [{ name: "borrowerProxy", type: "address" }],
    outputs: [{ name: "seizedAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // VaultSwap function - swap seized vault for WBTC
  {
    type: "function",
    name: "swapVaultForWbtc",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "wbtcOut", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // View functions
  {
    type: "function",
    name: "getVaultOwner",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "vaultOwner",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPosition",
    inputs: [{ name: "positionId", type: "bytes32" }],
    outputs: [
      {
        name: "position",
        type: "tuple",
        components: [
          {
            name: "depositor",
            type: "tuple",
            components: [
              { name: "ethAddress", type: "address" },
              { name: "btcPubKey", type: "bytes32" },
            ],
          },
          { name: "reserveId", type: "uint256" },
          { name: "proxyContract", type: "address" },
          { name: "vaultIds", type: "bytes32[]" },
          { name: "totalCollateral", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPositionByProxy",
    inputs: [{ name: "proxyAddress", type: "address" }],
    outputs: [
      { name: "positionId", type: "bytes32" },
      {
        name: "position",
        type: "tuple",
        components: [
          {
            name: "depositor",
            type: "tuple",
            components: [
              { name: "ethAddress", type: "address" },
              { name: "btcPubKey", type: "bytes32" },
            ],
          },
          { name: "reserveId", type: "uint256" },
          { name: "proxyContract", type: "address" },
          { name: "vaultIds", type: "bytes32[]" },
          { name: "totalCollateral", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Events
  {
    type: "event",
    name: "BTCVaultCoreSpokeLiquidated",
    inputs: [
      { name: "borrowerProxy", type: "address", indexed: true },
      { name: "liquidator", type: "address", indexed: true },
      { name: "depositor", type: "address", indexed: false },
      { name: "debtRepaid", type: "uint256", indexed: false },
      { name: "seizedAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VaultOwnershipTransferred",
    inputs: [
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
] as const;

// ERC20 ABI for approval
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

