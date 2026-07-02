import { LiquidationEngine, type LiquidationEngineConfig } from "@repo/engine";
import { createLogger } from "@repo/logger";

import { metrics } from "./metrics";

export type LiquidationBotConfig = Omit<LiquidationEngineConfig, "metrics" | "logger">;

/**
 * Composition wrapper: the shared `LiquidationEngine` wired with this service's
 * Prometheus metrics and a tagged logger. The pipeline logic lives in
 * `@repo/engine`.
 */
export class LiquidationBot extends LiquidationEngine {
  constructor(config: LiquidationBotConfig) {
    super({ ...config, metrics, logger: createLogger({ prefix: "[Bot] " }) });
  }
}
