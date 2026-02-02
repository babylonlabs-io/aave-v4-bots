// Spoke ABI - used by liquidator for reserve discovery

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
