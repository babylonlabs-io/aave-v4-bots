// VaultSwap ABI - methods used by arbitrageur bot

import { protocolErrorsAbi } from "./protocolErrors";

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
  // The LLP's own WBTC. Read at boot under router funding: the router's WBTC is immutable while its
  // `vaultSwap` is a per-call argument, so the two can disagree and every acquisition would revert.
  {
    type: "function",
    name: "WBTC",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
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
  // Every custom error in the call graph, not just BTCVaultSwap's own. The acquisition path
  // (`swapWbtcForVault`, `swapWbtcForVaultOnBehalf`) reverts from inside the registries at least
  // as often as it does from this contract — `UnauthorizedVaultKeeper()` is an ApplicationRegistry
  // error — and viem can only name a selector the call's own ABI declares. See `protocolErrors.ts`.
  ...protocolErrorsAbi,
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
