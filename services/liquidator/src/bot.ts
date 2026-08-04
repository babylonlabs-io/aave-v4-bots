import { LiquidationEngine, type LiquidationEngineConfig } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { updateLastPollTime } from "@repo/observability";

import { metrics } from "./metrics";

/**
 * The `risk` gate is **injected**, not constructed here: a process must have exactly one
 * `RiskGate` so a kill-switch / tripped breaker halts every engine it owns.
 */
export type LiquidationBotConfig = Omit<
  LiquidationEngineConfig,
  "metrics" | "logger" | "onPollComplete"
>;

/**
 * Composition wrapper: the shared `LiquidationEngine` wired with this service's
 * Prometheus metrics and a tagged logger. The pipeline logic lives in `@repo/engine`.
 */
export class LiquidationBot extends LiquidationEngine {
  constructor(config: LiquidationBotConfig) {
    super({
      ...config,
      metrics,
      logger: createLogger({ prefix: "[Bot] " }),
      onPollComplete: updateLastPollTime,
    });
  }
}
