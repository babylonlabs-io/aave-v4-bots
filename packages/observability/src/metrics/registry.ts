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
  /**
   * Record how a submitter answered one broadcast: `accepted`, `rejected` (it is certain nothing
   * went out) or `ambiguous` (it may or may not have). Process-level like the RPC counter — one
   * submitter serves every engine — and the only place an operator can see private submission being
   * *refused*, as opposed to accepted and then quietly never landing.
   */
  recordSubmit(result: "accepted" | "rejected" | "ambiguous"): void;
  /**
   * Record one relay status observation. `sim_error` is kept apart from the lifecycle statuses on
   * purpose: it means our own transaction is defective rather than out-competed, so it is what
   * distinguishes "the fee floor is too low / the call is broken" from "we are losing races".
   */
  recordRelayStatus(status: string): void;
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

  // Submission health. Both are process-level: one submitter, one relay, shared by every engine.
  const submitTotal = new Counter({
    name: "submitter_send_total",
    help: "Broadcast attempts by how the submitter answered (accepted | rejected | ambiguous)",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const relayStatusTotal = new Counter({
    name: "relay_tx_status_total",
    help: "Relay status observations for privately-submitted transactions, plus sim_error/probe_error",
    labelNames: ["status"] as const,
    registers: [registry],
  });

  return {
    registry,
    recordRpcCall(method: string): void {
      rpcCallsTotal.inc({ method });
    },
    recordSubmit(result): void {
      submitTotal.inc({ result });
    },
    recordRelayStatus(status: string): void {
      relayStatusTotal.inc({ status });
    },
    getMetrics(): Promise<string> {
      return registry.metrics();
    },
    getMetricsContentType(): string {
      return registry.contentType;
    },
  };
}
