import {
  createArbitrageMetrics,
  createIndexerMetrics,
  createLiquidationMetrics,
  createMetricsRegistry,
} from "@repo/observability";

// One registry per service; each engine's metric set registers into it alongside
// the shared transport/default metrics, so all of them surface on one `/metrics`.
const runtimeMetrics = createMetricsRegistry();
const { registry, getMetrics, getMetricsContentType } = runtimeMetrics;

/** Prom-client implementation of the `ArbitrageEngine` metrics port. */
export const metrics = createArbitrageMetrics(registry);

/**
 * The `LiquidationEngine` metric set on the SAME registry — created only when the
 * arbitrageur also runs liquidations (opt-in), so the `liquidator_*` series don't
 * appear on an arbitrage-only deploy.
 */
export const createLiquidationMetricsSet = () => createLiquidationMetrics(registry);
/** Built once and shared: the guard counts indexer incidents, not per-engine ones. */
export const indexerMetrics = createIndexerMetrics(registry);

/**
 * The registry itself is what `startRuntime` takes — it already carries the recorders `BootDeps`
 * asks for, so there is no second object to assemble here and keep in step with that type.
 */
export { runtimeMetrics, getMetrics, getMetricsContentType };
