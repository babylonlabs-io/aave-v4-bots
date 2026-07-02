import { createArbitrageMetrics, createMetricsRegistry } from "@repo/metrics";

// One registry per service; the arbitrage engine's metric set registers into it
// alongside the shared transport/default metrics. A future service running
// multiple engines would add more `create*Metrics(registry)` calls here.
const { registry, recordRpcCall, getMetrics, getMetricsContentType } = createMetricsRegistry();

/** Prom-client implementation of the `ArbitrageEngine` metrics port. */
export const metrics = createArbitrageMetrics(registry);

export { recordRpcCall, getMetrics, getMetricsContentType };
