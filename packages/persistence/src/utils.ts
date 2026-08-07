import type { ProposedTx } from "@repo/execution";
import type { IntentInput } from "./types";

/**
 * Deterministic idempotency key for an action. Addresses are lower-cased so a checksum vs.
 * non-checksum spelling of the same address maps to one key. Fields are colon-joined; none
 * of them (chain id, hex address, action label, hex/id subject) contains a colon.
 */
export function idempotencyKey(input: IntentInput): string {
  return `${input.chainId}:${input.target.toLowerCase()}:${input.action}:${input.subject.toLowerCase()}`;
}

/**
 * A proposal names its chain twice — in the row (where it keys the intent) and in the payload
 * (where the `payloadHash` commits to it, and from which `operator-cli` reads which chain to
 * broadcast on). Every backend enforces the two agreeing, here, so it cannot be enforced in one
 * store and not the other.
 *
 * Disagreement is the ugly failure: the operator signs and broadcasts for the payload's chain while
 * dedup and reconcile key under the row's, so the bot never sees its own transaction and re-proposes
 * a subject it has already acted on.
 */
export function assertProposalChain(input: IntentInput, payload: ProposedTx): void {
  if (input.chainId !== payload.chainId) {
    throw new Error(
      `proposal chain mismatch: intent is for chain ${input.chainId} but its payload targets ${payload.chainId}`
    );
  }
}
