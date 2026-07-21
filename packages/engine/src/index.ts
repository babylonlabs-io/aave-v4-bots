// Orchestration engines — each drives a pipeline over the domain / chain / execution
// modules and reports through an injected metrics port. Two engines because the
// arbitrageur will run both (direct-redemption liquidation + vault arbitrage).

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
} from "./executor";
