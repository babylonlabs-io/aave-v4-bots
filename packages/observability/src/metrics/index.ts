// Prom-client adapters for the engine metrics ports. Each engine's metric set
// is a factory that registers into a shared registry, so a service running one
// or several engines exposes them all through a single `/metrics` endpoint.
//
// The engines own their metric *ports* (`ArbitrageMetrics`, `LiquidationMetrics`); these are the
// implementations. Those are `import type` only — erased at compile time — so `@repo/engine` is a
// **devDependency** of this package and never enters a consumer's runtime graph (same arrangement
// `@repo/config` uses for its sibling types).

export { type MetricsRegistry, createMetricsRegistry } from "./registry";
export { createLiquidationMetrics } from "./liquidation";
export { createArbitrageMetrics } from "./arbitrage";
export { createIndexerMetrics } from "./indexer";
