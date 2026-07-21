// Orchestration engines — each drives a pipeline over the domain / chain / capital /
// execution modules and reports through an injected metrics port. Two engines because
// the arbitrageur will run both (direct-redemption liquidation + vault arbitrage).

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

export { createChainReader } from "./chainReader";
