import {
  createIndexerMetrics,
  createLiquidationMetrics,
  createMetricsRegistry,
} from "@repo/observability";

// One registry per service; the liquidation engine's metric set registers into
// it alongside the shared transport/default metrics. A future service running
// multiple engines would add more `create*Metrics(registry)` calls here.
const runtimeMetrics = createMetricsRegistry();
const { registry, getMetrics, getMetricsContentType } = runtimeMetrics;

/** Prom-client implementation of the `LiquidationEngine` metrics port. */
export const metrics = createLiquidationMetrics(registry);
/** Process-level, not engine-level: one indexer, however many engines read it. */
export const indexerMetrics = createIndexerMetrics(registry);

/**
 * The registry itself is what `startRuntime` takes — it already carries the recorders `BootDeps`
 * asks for, so there is no second object to assemble here and keep in step with that type.
 */
export { runtimeMetrics, getMetrics, getMetricsContentType };
