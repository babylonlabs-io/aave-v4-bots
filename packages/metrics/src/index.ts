// Prom-client adapters for the engine metrics ports. Each engine's metric set
// is a factory that registers into a shared registry, so a service running one
// or several engines exposes them all through a single `/metrics` endpoint.

export { type MetricsRegistry, createMetricsRegistry } from "./registry";
export { createLiquidationMetrics } from "./liquidation";
export { createArbitrageMetrics } from "./arbitrage";
