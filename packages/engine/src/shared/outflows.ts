import type { RiskGate } from "@repo/risk";
import type { Hex, PublicClient } from "viem";

import type { Executor } from "./executor";

/** The one thing this needs an executor for — see `Executor.inFlightTxHashes`. */
type InFlightSource = Pick<Executor, "inFlightTxHashes">;

/**
 * Retire the risk gate's outflow holds that a balance read at `block` will already account for.
 *
 * The gate holds a broadcast outflow from the moment its slot settles until something proves what
 * became of it, because a settled slot stops reserving while the transaction carrying it may still
 * be sitting un-mined — and a `balanceOf` taken meanwhile reports the money as if it had never
 * left. The gate cannot resolve that itself: it is synchronous and reads no chain. This is the
 * other half.
 *
 * Two kinds of proof, and nothing else counts:
 *
 * - **A receipt at or below `block`.** Whatever the transaction did — moved the money, or reverted
 *   and moved nothing — a read at that height reports the result. Note the direction of the
 *   comparison: a receipt from a *later* block than the read retires nothing, because the read
 *   predates it. That is the case an unpinned `latest` read hides, and why the caller pins.
 * - **The transaction is no longer in flight.** A dropped or replaced transaction never gets a
 *   receipt, so without this its hold would outlive it and quietly shrink the account's capacity
 *   for the life of the process. `reconcile` has already judged those rows this cycle; a hash it no
 *   longer lists is one the chain has moved past.
 *
 * Elapsed time is deliberately not proof. A claim on a balance does not expire because a timer did,
 * and a transaction that mines an hour late still spends the money.
 *
 * Callers must apply the fresh balances in the same synchronous step that follows this one — see
 * `RiskGate.retireOutflow` — so nothing can be judged against a balance that has lost the hold but
 * not yet gained the read.
 */
export async function retireSettledOutflows(deps: {
  publicClient: PublicClient;
  risk: RiskGate;
  executor: InFlightSource;
  /** Height every balance in this refresh is read at. */
  block: bigint;
}): Promise<void> {
  const { publicClient, risk, executor, block } = deps;
  const outflows = risk.outflows();
  if (outflows.length === 0) return;

  // Read once for the whole pass rather than per hold. `undefined` means this process keeps no
  // store and cannot answer, in which case a hold is retired only by a receipt.
  const inFlight = await executor.inFlightTxHashes();

  const retirable = await Promise.all(
    outflows.map(async ({ txHash, minedAtBlock }) => {
      // Already known, from the receipt the engine saw. No RPC, and no way for a lagging endpoint
      // to answer differently than the one that produced it.
      if (minedAtBlock !== undefined) return minedAtBlock <= block;
      const receipt = await publicClient
        .getTransactionReceipt({ hash: txHash as Hex })
        .catch(() => null);
      if (receipt) return receipt.blockNumber <= block;
      // No receipt: mined nowhere yet. Only the intent record can say whether it still could be.
      return inFlight !== undefined && !inFlight.has(txHash as Hex);
    })
  );

  for (const [i, ok] of retirable.entries()) if (ok) risk.retireOutflow(outflows[i].txHash);
}
