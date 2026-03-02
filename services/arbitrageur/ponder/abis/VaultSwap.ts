export const vaultSwapAbi = [
  // ═══════════════════════════════════════════════════════════════════════════
  //                              EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    type: "event",
    name: "AddedVault",
    inputs: [{ name: "vaultId", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "RemovedVault",
    inputs: [{ name: "vaultId", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "VaultEmergencyRepaid",
    inputs: [
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "wbtcRepaid", type: "uint256", indexed: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //                              VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    type: "function",
    name: "isVaultEscrowed",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewWbtcToAcquireVault",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "wbtcNeeded", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getEscrowedVaultsInfo",
    inputs: [{ name: "_escrowedVaults", type: "bytes32[]" }],
    outputs: [
      {
        name: "vaults",
        type: "tuple[]",
        components: [
          { name: "vaultId", type: "bytes32" },
          { name: "btcAmount", type: "uint256" },
          { name: "hubDebt", type: "uint256" },
          { name: "protocolFee", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //                              IMMUTABLES (for reference)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    type: "function",
    name: "HUB",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WBTC",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "BTC_VAULTS_MANAGER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CONTROLLER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "WBTC_ASSET_ID",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
