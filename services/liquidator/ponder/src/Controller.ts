import { ponder } from "ponder:registry";
import { proxyMapping } from "ponder:schema";

/**
 * UserProxyCreated event handler
 * - Maps proxy address to borrower (EOA) address
 * - Used to resolve borrower for liquidateCorePosition calls
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
