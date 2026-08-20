export interface IndexingModes {
  indexLiquidation: boolean;
  indexArbitrage: boolean;
}

/**
 * Derive which index modes this instance runs from the configured contract
 * addresses, and validate the combination. Pure over `env`, so the gating logic
 * is unit-testable without ponder's virtual-module runtime.
 *
 * Fails fast (throws) on a half-configured liquidation setup or an empty one —
 * the same guards that back `ponder.config.ts`'s conditional contracts and the
 * `ponder.on(...)` handler registration, kept here as the single source of truth.
 */
export function resolveIndexingModes(env: NodeJS.ProcessEnv): IndexingModes {
  const hasSpoke = !!env.SPOKE_ADDRESS;
  const hasAdapter = !!env.ADAPTER_ADDRESS;

  // A half-configured liquidation mode is almost certainly a typo, not an intent
  // to disable it — fail loudly rather than silently indexing nothing.
  if (hasSpoke !== hasAdapter) {
    throw new Error(
      "Liquidation indexing requires BOTH SPOKE_ADDRESS and ADAPTER_ADDRESS (set both or neither)."
    );
  }

  const indexLiquidation = hasAdapter && hasSpoke;
  const indexArbitrage = !!env.VAULT_SWAP_ADDRESS;

  if (!indexLiquidation && !indexArbitrage) {
    throw new Error(
      "Enable at least one index mode: set ADAPTER_ADDRESS + SPOKE_ADDRESS (liquidation) " +
        "and/or VAULT_SWAP_ADDRESS (arbitrage)."
    );
  }

  return { indexLiquidation, indexArbitrage };
}
