export const aaveIntegrationControllerAbi = [
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
    inputs: [{ name: "borrowerProxy", type: "address" }],
    outputs: [{ name: "seizedAmount", type: "uint256" }],
    stateMutability: "nonpayable",
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

export const spokeAbi = [
  {
    type: "function",
    name: "getReserveCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getReserve",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "underlying", type: "address" },
          { name: "hub", type: "address" },
          { name: "assetId", type: "uint16" },
          { name: "decimals", type: "uint8" },
          { name: "dynamicConfigKey", type: "uint24" },
          { name: "paused", type: "bool" },
          { name: "frozen", type: "bool" },
          { name: "borrowable", type: "bool" },
          { name: "collateralRisk", type: "uint24" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

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
