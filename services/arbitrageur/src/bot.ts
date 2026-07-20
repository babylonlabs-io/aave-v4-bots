import { ArbitrageEngine, type ArbitrageEngineConfig } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { updateLastPollTime } from "@repo/observability";
import { createRiskGate } from "@repo/risk";

import { metrics } from "./metrics";

export type ArbitrageurBotConfig = Omit<
  ArbitrageEngineConfig,
  "metrics" | "logger" | "risk" | "onPollComplete"
>;

/**
 * Composition wrapper: the shared `ArbitrageEngine` wired with this service's
 * Prometheus metrics, a tagged logger, a risk gate (permissive by default), and
 * the health poll-timestamp hook. The pipeline logic lives in `@repo/engine`.
 */
export class ArbitrageurBot extends ArbitrageEngine {
  constructor(config: ArbitrageurBotConfig) {
    super({
      ...config,
      metrics,
      logger: createLogger({ prefix: "[Arbitrageur] " }),
      risk: createRiskGate(),
      onPollComplete: updateLastPollTime,
    });
  }
}
