import type { IntentInput } from "./types";

/**
 * Deterministic idempotency key for an action. Addresses are lower-cased so a checksum vs.
 * non-checksum spelling of the same address maps to one key. Fields are colon-joined; none
 * of them (chain id, hex address, action label, hex/id subject) contains a colon.
 */
export function idempotencyKey(input: IntentInput): string {
  return `${input.chainId}:${input.target.toLowerCase()}:${input.action}:${input.subject.toLowerCase()}`;
}
