import { describe, expect, it } from "vitest";
import { createArbitrageMetrics } from "./arbitrage";
import { createLiquidationMetrics } from "./liquidation";
import { createMetricsRegistry } from "./registry";

describe("@repo/metrics", () => {
  it("exposes the liquidation metric set through the registry", async () => {
    const { registry } = createMetricsRegistry();
    const metrics = createLiquidationMetrics(registry);

    metrics.recordPositionsChecked(5);
    metrics.recordLiquidationSuccess();
    metrics.recordTokenBalance("WBTC", "0xabc", 100_000_000n, 8);

    const out = await registry.metrics();
    expect(out).toContain("liquidator_positions_checked 5");
    expect(out).toContain("liquidator_liquidations_total 1");
    expect(out).toContain('liquidator_token_balance{token="WBTC",address="0xabc"} 1');
  });

  it("records the shared eth_rpc_calls_total counter", async () => {
    const { registry, recordRpcCall } = createMetricsRegistry();
    recordRpcCall("eth_call");
    recordRpcCall("eth_call");

    const out = await registry.metrics();
    expect(out).toContain('eth_rpc_calls_total{method="eth_call"} 2');
  });

  it("hosts both engines on one registry without metric-name collisions", async () => {
    // The arbitrageur will run both engines — both metric sets must coexist.
    const { registry } = createMetricsRegistry();

    expect(() => {
      createLiquidationMetrics(registry);
      createArbitrageMetrics(registry);
    }).not.toThrow();

    const out = await registry.metrics();
    expect(out).toContain("liquidator_poll_duration_seconds");
    expect(out).toContain("arbitrageur_poll_duration_seconds");
  });

  it("keeps separate registries isolated", async () => {
    const a = createMetricsRegistry();
    const b = createMetricsRegistry();
    createLiquidationMetrics(a.registry);

    // b never had the liquidation set registered.
    const outB = await b.registry.metrics();
    expect(outB).not.toContain("liquidator_positions_checked");
  });
});
