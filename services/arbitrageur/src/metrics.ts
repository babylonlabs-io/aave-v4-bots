import {
  createArbitrageMetrics,
  createLiquidationMetrics,
  createMetricsRegistry,
} from "@repo/observability";

// One registry per service; each engine's metric set registers into it alongside
// the shared transport/default metrics, so all of them surface on one `/metrics`.
const { registry, recordRpcCall, getMetrics, getMetricsContentType } = createMetricsRegistry();

/** Prom-client implementation of the `ArbitrageEngine` metrics port. */
export const metrics = createArbitrageMetrics(registry);

/**
 * The `LiquidationEngine` metric set on the SAME registry — created only when the
 * arbitrageur also runs liquidations (opt-in), so the `liquidator_*` series don't
 * appear on an arbitrage-only deploy.
 */
export const createLiquidationMetricsSet = () => createLiquidationMetrics(registry);

export { recordRpcCall, getMetrics, getMetricsContentType };
