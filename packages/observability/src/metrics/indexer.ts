import type { IndexerMetrics } from "@repo/engine";
import { Counter, Gauge, type Registry } from "prom-client";

/**
 * Prom-client implementation of the indexer-liveness metrics port.
 *
 * Unprefixed by engine (`indexer_*`, not `liquidator_*`) because the guard is process-level: one
 * indexer, however many engines read it.
 *
 * These are part of the guard, not decoration. Without them a skipped cycle is indistinguishable
 * from an idle one — which is the exact failure the guard exists to make visible.
 */
export function createIndexerMetrics(registry: Registry): IndexerMetrics {
  const lagBlocks = new Gauge({
    name: "indexer_lag_blocks",
    help: "Blocks the indexer is behind the chain at the last check",
    registers: [registry],
  });

  const cyclesSkippedTotal = new Counter({
    name: "indexer_cycles_skipped_total",
    help: "Poll cycles skipped because the indexer was lagging or unreadable",
    registers: [registry],
  });

  const haltsTotal = new Counter({
    name: "indexer_halts_total",
    help: "Times sustained indexer lag halted the risk gate",
    registers: [registry],
  });

  return {
    recordLag: (blocks) => lagBlocks.set(blocks),
    recordCycleSkipped: () => cyclesSkippedTotal.inc(),
    recordHalt: () => haltsTotal.inc(),
  };
}
