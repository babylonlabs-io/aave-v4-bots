export const spokeAbi = [
  // Events we index
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
      { name: "debtToLiquidate", type: "uint256", indexed: false },
      { name: "drawnSharesToLiquidate", type: "uint256", indexed: false },
      {
        name: "premiumDelta",
        type: "tuple",
        indexed: false,
        components: [
          { name: "sharesDelta", type: "int256" },
          { name: "offsetDeltaRay", type: "int256" },
          { name: "accruedPremiumRay", type: "uint256" },
          { name: "restoredPremiumRay", type: "uint256" },
        ],
      },
      { name: "collateralToLiquidate", type: "uint256", indexed: false },
      { name: "collateralSharesToLiquidate", type: "uint256", indexed: false },
      { name: "collateralSharesToLiquidator", type: "uint256", indexed: false },
    ],
  },
  // View function for health factor check
  {
    type: "function",
    name: "getUserAccountData",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "riskPremium", type: "uint256" },
          { name: "avgCollateralFactor", type: "uint256" },
          { name: "healthFactor", type: "uint256" },
          { name: "totalCollateralValue", type: "uint256" },
          { name: "totalDebtValue", type: "uint256" },
          { name: "activeCollateralCount", type: "uint256" },
          { name: "borrowedCount", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

