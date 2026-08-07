import type { ArbitrageMetrics } from "@repo/engine";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";

/**
 * Prom-client implementation of the `ArbitrageEngine` metrics port. Registers
 * the `arbitrageur_*` metric set into `registry` and returns the port object
 * the engine reports through.
 */
export function createArbitrageMetrics(registry: Registry): ArbitrageMetrics {
  const vaultsAcquiredTotal = new Counter({
    name: "arbitrageur_vaults_acquired_total",
    help: "Total number of vaults successfully acquired",
    registers: [registry],
  });

  const wbtcSpentTotal = new Counter({
    name: "arbitrageur_wbtc_spent_total",
    help: "Total WBTC spent acquiring vaults (in satoshis)",
    registers: [registry],
  });

  const errorsTotal = new Counter({
    name: "arbitrageur_errors_total",
    help: "Total number of errors by type",
    labelNames: ["type"] as const,
    registers: [registry],
  });

  const pollDurationSeconds = new Histogram({
    name: "arbitrageur_poll_duration_seconds",
    help: "Duration of each poll cycle in seconds",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  });

  const lastPollTimestamp = new Gauge({
    name: "arbitrageur_last_poll_timestamp",
    help: "Unix timestamp of the last successful poll",
    registers: [registry],
  });

  const wbtcBalance = new Gauge({
    name: "arbitrageur_wbtc_balance",
    help: "Current WBTC balance of the arbitrageur (in satoshis)",
    registers: [registry],
  });

  // Labelled by owner so the treasury's figures never overwrite the signer's, matching how the
  // risk gate keys its ledger by `(owner, token)`.
  const fundingBalance = new Gauge({
    name: "arbitrageur_funding_wbtc_balance",
    help: "WBTC held by the account that pays for acquisitions (in satoshis)",
    labelNames: ["owner"] as const,
    registers: [registry],
  });

  const fundingAllowance = new Gauge({
    name: "arbitrageur_funding_wbtc_allowance",
    help: "WBTC the payer has approved the router to spend (in satoshis). Absent under inventory funding, where the payer spends directly",
    labelNames: ["owner"] as const,
    registers: [registry],
  });

  return {
    recordVaultAcquired(wbtcPaidSatoshis) {
      vaultsAcquiredTotal.inc();
      wbtcSpentTotal.inc(Number(wbtcPaidSatoshis));
    },
    recordError(type) {
      errorsTotal.inc({ type });
    },
    recordPollDuration(durationMs) {
      pollDurationSeconds.observe(durationMs / 1000);
      lastPollTimestamp.set(Date.now() / 1000);
    },
    recordWbtcBalance(balanceSatoshis) {
      wbtcBalance.set(Number(balanceSatoshis));
    },
    recordFundingCapacity({ owner, balance, allowance }) {
      fundingBalance.set({ owner }, Number(balance));
      if (allowance !== undefined) fundingAllowance.set({ owner }, Number(allowance));
    },
  };
}
