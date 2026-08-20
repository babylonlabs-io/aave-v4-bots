/**
 * Classification of the reverts the API's live contract probes come back with.
 *
 * Kept apart from the route handlers because those import Ponder's virtual `ponder:api` module and
 * cannot be loaded outside a running indexer — this is the part worth testing.
 *
 * The distinction every probe has to make is the same one: a revert that is the contract answering
 * the question ("this position is healthy", "this vault has left escrow") versus a revert that is
 * the deployment being broken. They arrive in the same shape, and the cost of conflating them runs
 * one way — a fault classified as an answer becomes a `200` with an empty list, which reads exactly
 * like a quiet market.
 */

import { LENS_HEALTHY_POSITION_REVERT, VAULT_GONE_ERRORS } from "@repo/abis";
import { BaseError, ContractFunctionRevertedError } from "viem";

// viem wraps on-chain reverts as ContractFunctionExecutionError whose `.cause` is
// ContractFunctionRevertedError, so a bare instanceof check on the top-level error
// always fails. Walk the cause chain instead.
function asRevert(error: unknown): ContractFunctionRevertedError | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert : undefined;
}

/**
 * Is this revert `estimateLiquidation` reporting a healthy position?
 *
 * That is the expected answer for most of the table on every cycle, so it must be skipped in
 * silence. Matched exactly, because *every other* revert out of that call is a fault wearing the
 * same clothes: `InvalidOraclePrice()` when a reserve's feed reads zero, an empty revert when
 * `lensAddress` points at the wrong contract, whatever a paused dependency raises. Accepting the
 * whole category is how a deployment that can no longer see any position reports that there are
 * none — and "no candidates" is the one answer a liquidator must never infer from a failure.
 *
 * `"Position must be healthy after liquidation"` is deliberately *not* here: a position too far
 * underwater for this call to restore is a real condition worth surfacing, not a healthy one.
 */
export function isHealthyPositionRevert(error: unknown): boolean {
  return asRevert(error)?.reason === LENS_HEALTHY_POSITION_REVERT;
}

// `previewEscrowedVaults` validates every vault it is given and reverts the whole call if any one
// of them has left escrow. The indexer lags the chain, so it routinely still lists vaults that were
// just acquired — those are gone, not broken, and must not be reported as fetch failures. Decoding
// this relies on the error entries in `vaultSwapAbi`; without them viem yields no `errorName` and
// every acquired vault would look like an infrastructure fault again.
const vaultGoneErrors: ReadonlySet<string> = new Set(VAULT_GONE_ERRORS);

export function isVaultGoneRevert(error: unknown): boolean {
  const name = asRevert(error)?.data?.errorName;
  return name !== undefined && vaultGoneErrors.has(name);
}

/**
 * The shortest thing that identifies *why* a probe failed — a custom error's name, a `require`
 * string, or the transport error when the call never reached a revert at all.
 *
 * Names the cause rather than dumping the error: viem's messages carry the full call, ABI and docs
 * link, which is unreadable once the same fault repeats across a whole batch of positions.
 *
 * `Error` and `Panic` are decoded names too, and useless ones — every `require` in the call graph
 * decodes to `errorName: "Error"`. For those the payload is the identity, so the reason wins.
 */
export function describeRevert(error: unknown): string {
  const revert = asRevert(error);
  if (revert) {
    const name = revert.data?.errorName;
    if (name !== undefined && name !== "Error" && name !== "Panic") return name;
    return revert.reason ?? name ?? "revert with no data";
  }
  if (error instanceof Error) return error.message.split("\n")[0];
  return String(error);
}

/**
 * Tally of probes that failed for a reason the caller could not classify, grouped by cause.
 *
 * Grouped because a systemic fault — a stalled oracle, a wrong address, a paused spoke — hits every
 * row in the same cycle, and one log line per position is how the one signal that matters gets
 * lost in thousands of identical ones.
 */
export class FaultTally {
  private readonly counts = new Map<string, number>();
  private faulted = 0;

  record(error: unknown): void {
    this.faulted += 1;
    const cause = describeRevert(error);
    this.counts.set(cause, (this.counts.get(cause) ?? 0) + 1);
  }

  get count(): number {
    return this.faulted;
  }

  /** `3× InvalidOraclePrice; 1× revert with no data`, commonest first. */
  summary(): string {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cause, n]) => `${n}× ${cause}`)
      .join("; ");
  }
}
