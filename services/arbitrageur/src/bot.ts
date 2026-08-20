import { ArbitrageEngine, type ArbitrageEngineConfig } from "@repo/engine";
import { createLogger } from "@repo/logger";
import { updateLastPollTime } from "@repo/observability";

import { metrics } from "./metrics";

/**
 * The `risk` gate is **injected**, not constructed here: this process may run two engines off
 * one signer, and they must share a single `RiskGate` so a kill-switch / tripped breaker halts
 * **both** (previously each engine built its own, so halting one left the other trading).
 */
export type ArbitrageurBotConfig = Omit<
  ArbitrageEngineConfig,
  "metrics" | "logger" | "onPollComplete"
>;

/**
 * Composition wrapper: the shared `ArbitrageEngine` wired with this service's
 * Prometheus metrics, a tagged logger, and the health poll-timestamp hook.
 * The pipeline logic lives in `@repo/engine`.
 */
export class ArbitrageurBot extends ArbitrageEngine {
  constructor(config: ArbitrageurBotConfig) {
    super({
      ...config,
      metrics,
      logger: createLogger({ prefix: "[Arbitrageur] " }),
      onPollComplete: updateLastPollTime,
    });
  }
}
