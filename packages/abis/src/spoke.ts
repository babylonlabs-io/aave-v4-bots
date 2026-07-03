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
  // Events — consumed by the Ponder indexer (@services/ponder)
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "suppliedShares", type: "uint256", indexed: false },
      { name: "suppliedAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "withdrawnShares", type: "uint256", indexed: false },
      { name: "withdrawnAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LiquidationCall",
    inputs: [
      { name: "collateralReserveId", type: "uint256", indexed: true },
      { name: "debtReserveId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "liquidator", type: "address", indexed: false },
      { name: "receiveShares", type: "bool", indexed: false },
      { name: "debtAmountRestored", type: "uint256", indexed: false },
      { name: "drawnSharesLiquidated", type: "uint256", indexed: false },
      {
        name: "premiumDelta",
        type: "tuple",
        indexed: false,
        components: [
          { name: "sharesDelta", type: "int256" },
          { name: "offsetRayDelta", type: "int256" },
          { name: "restoredPremiumRay", type: "uint256" },
        ],
      },
      { name: "collateralAmountRemoved", type: "uint256", indexed: false },
      { name: "collateralSharesLiquidated", type: "uint256", indexed: false },
      { name: "collateralSharesToLiquidator", type: "uint256", indexed: false },
    ],
  },
] as const;
