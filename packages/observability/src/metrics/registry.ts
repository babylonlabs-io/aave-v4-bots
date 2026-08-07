import { Counter, Registry, collectDefaultMetrics } from "prom-client";

/**
 * The shared prom-client registry plus the service-level (engine-agnostic)
 * instrumentation. Engine metric sets — `createLiquidationMetrics`,
 * `createArbitrageMetrics` — register their counters into `registry`, so a
 * single service can host one or many engines behind one `/metrics` endpoint.
 */
export interface MetricsRegistry {
  /** The registry every engine metric set registers into. */
  registry: Registry;
  /**
   * Record one outbound JSON-RPC method call. Transport-level and
   * engine-agnostic — wired into `instrumentedHttp`, not an engine port.
   */
  recordRpcCall(method: string): void;
  /** Serialize all registered metrics in Prometheus text format. */
  getMetrics(): Promise<string>;
  /** Content-type for the Prometheus exposition format. */
  getMetricsContentType(): string;
}

/**
 * Create a fresh metrics registry wired with default Node.js metrics (memory,
 * CPU, event loop) and the shared `eth_rpc_calls_total` transport counter.
 */
export function createMetricsRegistry(): MetricsRegistry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const rpcCallsTotal = new Counter({
    name: "eth_rpc_calls_total",
    help: "Total outbound JSON-RPC method calls (one increment per provider charge)",
    labelNames: ["method"] as const,
    registers: [registry],
  });

  return {
    registry,
    recordRpcCall(method: string): void {
      rpcCallsTotal.inc({ method });
    },
    getMetrics(): Promise<string> {
      return registry.metrics();
    },
    getMetricsContentType(): string {
      return registry.contentType;
    },
  };
}
