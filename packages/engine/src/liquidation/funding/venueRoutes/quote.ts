import { type Address, getAddress } from "viem";

/**
 * Refuses a quote request no source should answer: another token, or a size that is not positive.
 * Both mean the caller is broken, so they throw instead of answering `available: false` — which
 * would read a bug as "this venue cannot fund it".
 */
export function assertQuotable(id: string, token: Address, asset: Address, amount: bigint): void {
  if (getAddress(asset) !== getAddress(token)) {
    throw new Error(`venue ${id} lends ${getAddress(token)}, not ${getAddress(asset)}`);
  }
  if (amount <= 0n) throw new Error(`venue ${id}: amount must be positive, got ${amount}`);
}
