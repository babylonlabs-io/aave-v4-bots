// VaultSwap ABI - methods used by arbitrageur bot

export const vaultSwapAbi = [
  // Acquire vault (redemption happens atomically inside). `msg.sender` must be a
  // registered vault keeper — the vault is redeemed to its registered BTC key.
  {
    type: "function",
    name: "swapWbtcForVault",
    inputs: [
      { name: "vaultId", type: "bytes32" },
      { name: "maxWbtcIn", type: "uint256" },
    ],
    outputs: [{ name: "amountWbtcIn", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Same acquisition, but the payer and the beneficiary are separate: `msg.sender` pays the
  // WBTC while the vault is redeemed to `onBehalfOf`'s BTC key. Only `onBehalfOf` must be a
  // registered vault keeper, which is what lets a non-keeper payer (a treasury multisig, or a
  // Safe in MANUAL custody) fund acquisitions for a permissioned keeper.
  {
    type: "function",
    name: "swapWbtcForVaultOnBehalf",
    inputs: [
      { name: "vaultId", type: "bytes32" },
      { name: "maxWbtcIn", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "wbtcPaid", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Whether a vault is still in escrow and available to acquire. Goes false once acquired — the
  // arbitrage engine reads it after a reverted swap to tell a lost race (another arbitrageur got
  // there first) from a genuine failure.
  {
    type: "function",
    name: "isVaultAcquirable",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // Repay interest on an escrowed vault
  {
    type: "function",
    name: "repayVaultInterest",
    inputs: [
      { name: "vaultId", type: "bytes32" },
      { name: "wbtcToRepay", type: "uint256" },
    ],
    outputs: [{ name: "wbtcPaid", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Batch preview of escrowed vaults with full debt/profitability info
  {
    type: "function",
    name: "previewEscrowedVaults",
    inputs: [{ name: "_escrowedVaults", type: "bytes32[]" }],
    outputs: [
      {
        name: "vaults",
        type: "tuple[]",
        components: [
          { name: "vaultId", type: "bytes32" },
          { name: "amountVault", type: "uint256" },
          { name: "amountDebt", type: "uint256" },
          { name: "amountInterest", type: "uint256" },
          { name: "amountFee", type: "uint256" },
          { name: "amountWbtcEquivalent", type: "uint256" },
          { name: "amountWbtcToAcquire", type: "uint256" },
          { name: "amountProfitEst", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  // Events — consumed by the Ponder indexer (@services/ponder)
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
  // Custom errors reachable from the acquisition path (`swapWbtcForVault`,
  // `swapWbtcForVaultOnBehalf`) and from `previewEscrowedVaults`, which validates every vault in
  // the batch. Without these viem cannot decode a revert and logs the raw 4-byte selector plus
  // "not found on the provided ABI" — so the routine case, losing a race, reads like an ABI bug.
  // Names and argument types must match `AdapterErrors`; the selector is what decoding keys on.
  {
    type: "error",
    name: "VaultNotAcquirable",
    inputs: [],
  },
  {
    type: "error",
    name: "SlippageExceeded",
    inputs: [
      { name: "minOut", type: "uint256" },
      { name: "actualOut", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InvalidEscrowedVaultStatus",
    inputs: [],
  },
  {
    type: "error",
    name: "ProfitLowerboundNotReached",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
  // BTCVaultSwap uses its own pause/authorisation errors (TBV_*), not OpenZeppelin's Pausable.
  // `TBV_Paused` is what a halted protocol looks like to the bot; `TBV_Unauthorized` is what an
  // unregistered vault keeper looks like — both are operator problems, not chain problems, and
  // both are worth reading in the log rather than as a bare selector.
  {
    type: "error",
    name: "TBV_Paused",
    inputs: [],
  },
  {
    type: "error",
    name: "TBV_Unauthorized",
    inputs: [],
  },
  // A failed WBTC pull (allowance or balance short at execution time).
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [{ name: "token", type: "address" }],
  },
] as const;

/** Every custom error `vaultSwapAbi` can decode, as a union of their names. */
export type VaultSwapErrorName = Extract<(typeof vaultSwapAbi)[number], { type: "error" }>["name"];

/**
 * The reverts that mean "this vault is no longer yours to take" rather than "something is broken":
 * it was acquired between an indexer read and the call. Callers use this to drop a vault quietly
 * instead of reporting a fault — see the `/escrowed-vaults` fallback in @services/ponder.
 *
 * Typed against the ABI above, so renaming or removing one of these errors is a compile error here
 * rather than a silently-never-matching string at a call site.
 */
export const VAULT_GONE_ERRORS = [
  "VaultNotAcquirable",
  "InvalidEscrowedVaultStatus",
] as const satisfies readonly VaultSwapErrorName[];
