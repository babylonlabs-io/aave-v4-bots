import { LiquidationEngine, type LiquidationEngineConfig } from "@repo/engine";

import * as metrics from "./metrics";

export type LiquidationBotConfig = Omit<LiquidationEngineConfig, "metrics">;

/**
 * Composition wrapper: the shared `LiquidationEngine` wired with this service's
 * Prometheus metrics. The pipeline logic lives in `@repo/engine`.
 */
export class LiquidationBot extends LiquidationEngine {
  constructor(config: LiquidationBotConfig) {
    super({ ...config, metrics });
  }
}
