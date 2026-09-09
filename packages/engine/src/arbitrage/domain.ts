// Pure arbitrage-domain logic (no IO).

import type { EscrowedVault } from "./types";

/**
 * Max WBTC the arbitrageur will pay for a vault: the current Hub debt plus a
 * `slippageBps` buffer over it (protects against interest accrual between the
 * preview read and execution).
 *
 * The bound is checked here as well as at config load, because this number *is* the ceiling the
 * signer authorizes. Above 10000 bps it stops being a tolerance and becomes a multiplier — 20000
 * turns a 1 WBTC preview into a 3 WBTC ceiling — and nothing downstream reads as wrong: the payment
 * is simply authorized against a bound nobody intended. `minWbtcProfitFloor` guards its own bps the
 * same way, for the same reason.
 */
export function maxWbtcInWithSlippage(currentDebt: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer in [0, 10000], got ${slippageBps}`);
  }
  const buffer = (currentDebt * BigInt(slippageBps)) / 10_000n;
  return currentDebt + buffer;
}

/**
 * A `uint256` as the indexer serializes it: decimal digits, and nothing else.
 *
 * Stricter than "`BigInt()` accepts it" on purpose. `BigInt("")` is `0n`, and a vault whose debt
 * reads as zero is a vault that looks maximally profitable — so a shape check that only asked
 * whether the conversion throws would wave through the one malformed value that costs money.
 * Hex and scientific notation are rejected for the duller reason: the indexer does not emit them,
 * so a value in either form means the wire contract changed, and being dropped loudly beats being
 * reinterpreted quietly.
 */
const UINT_STRING = /^[0-9]+$/;

/**
 * `vaultId` reaches the chain as the `bytes32[]` argument of `previewEscrowedVaults`.
 *
 * Shape only, not width. A wrongly-sized id is rejected by viem's encoder, which throws inside
 * `prepareAndSend`'s `try` and costs that one vault — so checking the width here would duplicate a
 * guard that already exists and already fails safely. What this catches is the case nothing
 * downstream does: a value that is not a hex string at all.
 */
const HEX_STRING = /^0x[0-9a-fA-F]+$/;

/**
 * Is this element of the escrow feed one the engine can actually act on?
 *
 * The response crosses an unauthenticated wire and is *cast* to its type, never parsed, so nothing
 * before this point has established that a field is even a string. Only the three fields the engine
 * consumes are checked — `vaultId`, which is passed to the chain, and the two amounts, which are
 * converted with `BigInt`. `createdAt` is deliberately not checked: nothing reads it, and dropping a
 * vault over a field the engine never touches would cost real acquisitions for no gain.
 *
 * Used to reject the *entry*, never the cycle. One vault the indexer describes badly must not stop
 * the ones it described correctly — the same rule `failedVaultsCount` already follows.
 */
export function isUsableVault(vault: unknown): vault is EscrowedVault {
  if (typeof vault !== "object" || vault === null) return false;
  const { vaultId, btcAmount, currentDebt } = vault as Partial<EscrowedVault>;
  return (
    typeof vaultId === "string" &&
    HEX_STRING.test(vaultId) &&
    typeof btcAmount === "string" &&
    UINT_STRING.test(btcAmount) &&
    typeof currentDebt === "string" &&
    UINT_STRING.test(currentDebt)
  );
}
