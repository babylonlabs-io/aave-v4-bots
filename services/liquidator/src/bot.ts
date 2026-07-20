import { LiquidationEngine, type LiquidationEngineConfig } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { createRiskGate } from "@repo/risk";

import { metrics } from "./metrics";

export type LiquidationBotConfig = Omit<LiquidationEngineConfig, "metrics" | "logger" | "risk">;

/**
 * Composition wrapper: the shared `LiquidationEngine` wired with this service's
 * Prometheus metrics, a tagged logger, and a risk gate (permissive by default —
 * env-driven thresholds are a follow-up). The pipeline logic lives in `@repo/engine`.
 */
export class LiquidationBot extends LiquidationEngine {
  constructor(config: LiquidationBotConfig) {
    super({
      ...config,
      metrics,
      logger: createLogger({ prefix: "[Bot] " }),
      risk: createRiskGate(),
    });
  }
}
