export const btcVaultsManagerAbi = [
  // ═══════════════════════════════════════════════════════════════════════════
  //                              EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emitted when a vault is redeemed and claimable by a specific BTC key.
   * This event signals that the vault has been redeemed and is no longer owned
   * by the arbitrageur on the EVM side.
   */
  {
    type: "event",
    name: "VaultClaimableBy",
    inputs: [
      { name: "vaultId", type: "bytes32", indexed: true },
      { name: "claimerPK", type: "bytes32", indexed: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  //                              VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    type: "function",
    name: "getBTCVault",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [
      {
        name: "vault",
        type: "tuple",
        components: [
          { name: "depositor", type: "address" },
          { name: "depositorBtcPubKey", type: "bytes32" },
          { name: "unsignedPegInTx", type: "bytes" },
          { name: "amount", type: "uint256" },
          { name: "vaultProvider", type: "address" },
          { name: "status", type: "uint8" },
          { name: "applicationController", type: "address" },
          { name: "universalChallengersVersion", type: "uint16" },
          { name: "appVaultKeepersVersion", type: "uint16" },
          { name: "offchainParamsVersion", type: "uint16" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;
