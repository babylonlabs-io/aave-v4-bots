import type { Hex } from "viem";

// Broadcast seam — **where** a signed transaction goes, as distinct from **who signed it**
// (`@repo/signer`). It lives here rather than beside the signer because `createTxSender` is what
// gives this contract its meaning: it decides what a rejection implies for the reserved nonce and
// for the failure breaker. A port whose semantics are defined by one consumer belongs with that
// consumer.
//
// There is deliberately no "public" adapter: broadcasting to the node's mempool is what
// `createTxSender` already does with no override, so a `Submitter` that did the same would be a
// second way to spell the default. A `Submitter` means "somewhere other than the mempool" —
// currently `./flashbots`, its sibling in this directory. If submission ever grows orchestration of its own — relay racing,
// replacement, cancellation, bundle lifecycle — this is the seam to lift into its own package;
// while it remains a parameter to `createTxSender`, it belongs here.

/** Where/how a signed tx is broadcast. */
export interface SubmitPolicy {
  readonly relay?: "public" | "flashbots-protect";
}

export interface Submitter {
  /** Broadcast a serialized signed tx; returns the tx hash. */
  send(serializedTransaction: Hex, policy?: SubmitPolicy): Promise<Hex>;
}

/**
 * The submitter refused the transaction outright: it was **never broadcast**, the reserved nonce is
 * still free, and the caller may abandon cleanly without feeding the failure breaker.
 *
 * Only a submitter may raise this, because only it knows its own protocol. The alternative — the
 * send path pattern-matching a *node's* error text, as `isInsufficientFunds` does — cannot survive
 * a second backend, and getting it wrong is asymmetric: a wrongly-clean error frees a nonce under a
 * transaction that may still land, while a wrongly-ambiguous one merely counts a failure it need
 * not have. So every submitter defaults to ambiguous and raises this only when certain.
 *
 * Distinct from `PreBroadcastError`, and the direction is what keeps them apart: this one travels
 * submitter → sender ("I am certain nothing was accepted"), while `PreBroadcastError` travels
 * sender → engine ("settle this as abandoned"). `createTxSender` is the translation.
 */
export class SubmitRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`submitter rejected the transaction: ${reason}`);
    this.name = "SubmitRejectedError";
  }
}
