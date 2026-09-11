import { isTxKnown } from "@repo/chain";
import type { RiskGate } from "@repo/risk";
import { type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";

import type { Executor } from "./executor";

/** The one thing this needs an executor for — see `Executor.inFlightTxHashes`. */
type InFlightSource = Pick<Executor, "inFlightTxHashes">;

/**
 * The held outflows a balance read at `block` already accounts for: the `settled` argument to
 * `RiskGate.applySnapshot`.
 *
 * A hold keeps a broadcast outflow counted after its slot settles, because the transaction may sit
 * un-mined while a `balanceOf` still reports the money. The gate is synchronous and reads no chain,
 * so this finds the evidence. Two kinds count, and nothing else:
 *
 * - **A receipt at or below `block`.** Whatever the transaction did, a read at that height reports
 *   it. A receipt from a later block retires nothing: the read predates it.
 * - **The transaction is no longer in flight.** A dropped or replaced transaction never gets a
 *   receipt; `reconcile` has already judged those rows this cycle. Without a store, a transaction
 *   the node no longer knows counts instead: only public submission runs without one, and there
 *   the node's answer is authoritative.
 *
 * Only a receipt lookup that answers "not found" counts as no receipt. Any other failure proves
 * nothing, so that hold stays. Elapsed time is not evidence either: a transaction that mines an
 * hour late still spends the money.
 *
 * Reads the chain but never mutates the gate, so the caller applies the result and the fresh
 * balances in one synchronous `applySnapshot`.
 */
export async function settledOutflows(deps: {
  publicClient: PublicClient;
  risk: RiskGate;
  executor: InFlightSource;
  /** Height every balance in this refresh is read at. */
  block: bigint;
}): Promise<string[]> {
  const { publicClient, risk, executor, block } = deps;
  const outflows = risk.outflows();
  if (outflows.length === 0) return [];

  // Read once for the whole pass rather than per hold. `undefined` means this process keeps no
  // store; the node answers instead.
  const inFlight = await executor.inFlightTxHashes();

  const settled = await Promise.all(
    outflows.map(async ({ txHash, minedAtBlock }) => {
      // Already known, from the receipt the engine saw. No RPC, and no way for a lagging endpoint
      // to answer differently than the one that produced it.
      if (minedAtBlock !== undefined) return minedAtBlock <= block;
      let receipt: { blockNumber: bigint } | null;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) return false;
        receipt = null;
      }
      if (receipt) return receipt.blockNumber <= block;
      // No receipt: mined nowhere yet. The intent record says whether it still could be.
      if (inFlight !== undefined) return !inFlight.has(txHash as Hex);
      // No store, so public submission: a transaction the node does not know is gone. A failed
      // lookup proves nothing, so the hold stays.
      try {
        return !(await isTxKnown(publicClient, txHash as Hex));
      } catch {
        return false;
      }
    })
  );

  return outflows.filter((_, i) => settled[i]).map(({ txHash }) => txHash);
}
