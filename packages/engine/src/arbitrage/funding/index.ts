import { InventoryFunding } from "./inventory";
import { RouterFunding } from "./router";
import type { ArbitrageFunding, FundingContext } from "./types";

// The seam's public surface: consumers import `./funding`, never its internals.
export * from "./types";
export { buildArbitrageFundingParams } from "./config";
export { InventoryFunding } from "./inventory";
export { RouterFunding } from "./router";

/**
 * Build the funding strategy the arbitrage engine will run with.
 *
 * Lives beside the engine rather than in `@repo/runtime` for the same reason the liquidation one
 * does: the runtime composes what is process-level and shared between engines — one signer, one
 * nonce authority, one risk gate, one executor — and engine domain params stay with the engine.
 */
export function createArbitrageFunding(context: FundingContext): ArbitrageFunding {
  const params = context.funding ?? { mode: "inventory" };
  if (params.mode === "inventory") return new InventoryFunding(context);

  // Both narrowings the router mode needs, in one place. The env-level projection cannot express
  // either — it never sees the executor, and the keeper is optional for the other mode.
  const { executor, vaultKeeperAddress } = context;
  if (executor.mode !== "AUTO") {
    throw new Error(
      "ARBITRAGE_FUNDING=router needs a key to authorize each acquisition, so it cannot run with EXECUTION_MODE=MANUAL."
    );
  }
  if (!vaultKeeperAddress) {
    throw new Error(
      "ARBITRAGE_FUNDING=router requires VAULT_KEEPER_ADDRESS: the router only ever redeems on behalf of a registered keeper."
    );
  }
  return new RouterFunding({
    ...context,
    executor,
    vaultKeeperAddress,
    routerAddress: params.routerAddress,
    deadlineSeconds: params.deadlineSeconds,
  });
}
