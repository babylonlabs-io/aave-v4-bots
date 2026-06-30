import { ponder } from "ponder:registry";
import { proxyMapping } from "ponder:schema";
import { INDEX_LIQUIDATION } from "./flags";

// Registered only when liquidation indexing is enabled, so `ponder.on("Adapter:…")`
// is never called for a contract the config didn't include.
if (INDEX_LIQUIDATION) {
  /**
   * UserProxyCreated event handler
   * - Maps proxy address to borrower (EOA) address
   * - Used to resolve borrower for liquidate / liquidateWithLLP calls
   */
  ponder.on("Adapter:UserProxyCreated", async ({ event, context }) => {
    const borrower = event.args.user;
    const proxyAddress = event.args.proxy;
    const timestamp = event.block.timestamp;

    await context.db
      .insert(proxyMapping)
      .values({
        proxyAddress,
        borrower,
        createdAt: timestamp,
      })
      .onConflictDoNothing();
  });
}
