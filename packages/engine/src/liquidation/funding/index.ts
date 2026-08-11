import { FlashFunding } from "./flash";
import { InventoryFunding } from "./inventory";
import type { FundingContext, LiquidationFunding } from "./types";

// The seam's public surface: consumers import `./funding`, never its internals — and get a mode
// only through `createFunding`, never by constructing one.
export * from "./types";
export { buildFundingParams } from "./config";
export {
  type FlashSwapVenue,
  type VenueRegistry,
  type WbtcFlashLoanVenue,
  VenueSelectionError,
  assertRegistryValid,
} from "./venues";

/**
 * Build the funding strategy the engine will run with.
 *
 * Both strategies read the same `FundingContext`, narrowing it with `Pick` rather than declaring
 * their own dependency lists. That is what keeps this function — and the engine's call to it —
 * short: a new shared dependency is one field on the context, not one more argument threaded
 * through the engine, the factory and both strategies.
 *
 * Lives here rather than in `@repo/runtime` deliberately. The runtime composes what is
 * *process-level and shared between engines* — one signer, one nonce authority, one risk gate, one
 * executor — and its own contract says engine domain params stay with the engine. Funding is
 * liquidation-only and built from liquidation addresses, so hoisting it would drag that domain into
 * a package the arbitrageur also boots from, for no gain.
 */
export function createLiquidationFunding(context: FundingContext): LiquidationFunding {
  const params = context.funding ?? { mode: "inventory" };
  return params.mode === "flash"
    ? new FlashFunding({
        ...context,
        routerAddress: params.routerAddress,
        venues: params.venues,
        maxSlippageBps: params.maxSlippageBps,
      })
    : new InventoryFunding(context);
}
