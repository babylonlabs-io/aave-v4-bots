import { createLiquidationMetrics, createMetricsRegistry } from "@repo/observability";

// One registry per service; the liquidation engine's metric set registers into
// it alongside the shared transport/default metrics. A future service running
// multiple engines would add more `create*Metrics(registry)` calls here.
const { registry, recordRpcCall, getMetrics, getMetricsContentType } = createMetricsRegistry();

/** Prom-client implementation of the `LiquidationEngine` metrics port. */
export const metrics = createLiquidationMetrics(registry);

export { recordRpcCall, getMetrics, getMetricsContentType };
