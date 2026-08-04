// Orchestration engines — each drives a pipeline over the domain / chain / execution
// modules and reports through an injected metrics port. Two engines because the
// arbitrageur will run both (direct-redemption liquidation + vault arbitrage).
//
// Layout: `liquidation/` and `arbitrage/` are the engines, and `shared/` holds what both of them
// depend on — the `BaseEngine` they extend (which owns the poll-cycle lifecycle), the `Executor`
// seam (with its crash-safety and reconcile internals), and the indexer liveness guard. Everything
// an engine reaches for is therefore a *sibling* directory, never a loose file in the package root.
// A new cross-engine collaborator belongs in `shared/`; one that only serves a single engine
// belongs beside it, the way `liquidation/funding/` does.
//
// `BaseEngine` is deliberately not re-exported: a composition root builds the two concrete engines,
// and nothing outside this package writes a third.

export {
  LiquidationEngine,
  type LiquidationEngineConfig,
  type LiquidationEngineParams,
  type LiquidationMetrics,
} from "./liquidation/engine";
export type { LiquidatablePosition } from "./liquidation/types";

export {
  ArbitrageEngine,
  type ArbitrageEngineConfig,
  type ArbitrageEngineParams,
  type ArbitrageMetrics,
} from "./arbitrage/engine";
export type { EscrowedVault } from "./arbitrage/types";

// The package's execution surface: the `Executor` seam plus the two factories the composition root
// (`@repo/runtime`) builds — an `AutoExecutor` from a wallet, or a keyless `ManualExecutor`. The
// lower-level `createAutoExecutor` (over a hand-built `CrashSafety` + `TxSender`) stays internal to
// the package — only its own unit tests use it, importing it directly from `./executor`.
export {
  type AutoExecutor,
  type CommitResult,
  type Executor,
  type ManualExecutor,
  createAutoExecutorFromWallet,
  createManualExecutor,
} from "./shared/executor";
// The funding seam's *configuration* surface — what a composition root supplies to pick a mode and
// describe its venues. The strategies themselves, the factory that chooses between them, and the
// per-candidate plumbing stay inside the package: the engine owns which strategy it runs, and
// exporting them would let a caller build one and hand it in behind the engine's back.
export {
  type FlashFundingParams,
  type FlashSwapVenue,
  type FundingParams,
  type VenueRegistry,
  type WbtcFlashLoanVenue,
  VenueSelectionError,
  assertRegistryValid,
  buildFundingParams,
} from "./liquidation/funding";
export { VenueType } from "@repo/abis";
// Indexer liveness. The guard is process-level (one indexer, however many engines read it), so a
// composition root builds it once and hands the same instance to each engine.
export {
  type Indexer,
  type IndexerGuardConfig,
  type IndexerMetrics,
  type IndexerStatus,
  type LagVerdict,
  assessIndexerLag,
  createIndexer,
  selectChainStatus,
} from "./shared/indexer";
