import { ArbitrageEngine, type ArbitrageEngineConfig } from "@repo/engine";
import { updateLastPollTime } from "@repo/observability";

import { metrics } from "./metrics";

export type ArbitrageurBotConfig = Omit<ArbitrageEngineConfig, "metrics" | "onPollComplete">;

/**
 * Composition wrapper: the shared `ArbitrageEngine` wired with this service's
 * Prometheus metrics and health poll-timestamp hook. The pipeline logic lives in
 * `@repo/engine`.
 */
export class ArbitrageurBot extends ArbitrageEngine {
  constructor(config: ArbitrageurBotConfig) {
    super({ ...config, metrics, onPollComplete: updateLastPollTime });
  }
}
