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
          { name: "collateralRisk", type: "uint24" },
          // Bitmap: 0x01=paused, 0x02=frozen, 0x04=borrowable (see
          // lib/aave-v4/src/spoke/libraries/ReserveFlagsMap.sol).
          { name: "flags", type: "uint8" },
          { name: "dynamicConfigKey", type: "uint32" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;
