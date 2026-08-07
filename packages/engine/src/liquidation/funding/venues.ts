import { type FlashData, type PoolKey, VenueType, encodePoolKey } from "@repo/abis";
import { type Address, getAddress } from "viem";

/**
 * Builds the `flashDatas` argument for `LiquidationRouter.liquidate`.
 *
 * The router funds a liquidation by flash-borrowing every token the borrower owes, and repays each
 * venue as the callback stack unwinds. Which token a venue wants back is what decides the whole
 * off-chain design:
 *
 * - a flash **loan** (Morpho, Aave v3) wants the *borrowed* token back, which the router does not
 *   have — it holds the seized WBTC — so it would have to sell WBTC first, via `swapDatas`;
 * - a flash **swap** (UniswapV4) wants the pool's *other* side, i.e. WBTC, because the pool already
 *   performed the conversion when it handed over the debt token.
 *
 * So funding every non-WBTC debt with a flash swap on a WBTC/<token> pool, and WBTC itself with a
 * plain flash loan, leaves every venue debt denominated in WBTC — and `swapDatas` can stay empty.
 * That is the configuration this module builds, and the invariants below are what keep it true.
 *
 * None of these are enforced on-chain, which is why they are assertions here rather than comments.
 */

/** Where to flash-borrow one non-WBTC debt token, and through which pool. */
export interface FlashSwapVenue {
  token: Address;
  /** The `UniswapV4SwapVenue` deployment bound to our router. */
  venueAddress: Address;
  poolKey: PoolKey;
}

/** Where to flash-borrow WBTC. A plain loan: borrowed and repaid in WBTC. */
export interface WbtcFlashLoanVenue {
  venueType: typeof VenueType.Morpho | typeof VenueType.AaveV3;
  venueAddress: Address;
}

export interface VenueRegistry {
  wbtc: Address;
  flashSwaps: readonly FlashSwapVenue[];
  /**
   * Required, not optional. Vaults are indivisible, so a liquidation seizes whole vaults and the
   * value left over once the debt is cleared is owed back to the borrower as the LLP fairness
   * payment — which the adapter pulls from the router in WBTC. Only a position deep enough
   * underwater to consume its vault entirely avoids one, and that is the exception rather than the
   * rule, so a flash setup without this venue would decline most of the work it was configured for.
   */
  wbtcFlashLoan: WbtcFlashLoanVenue;
}

/** A `flashDatas` that cannot be funded as specified. Carries which invariant failed. */
export class VenueSelectionError extends Error {
  constructor(
    readonly invariant: "I1" | "I2" | "I3" | "I4",
    message: string
  ) {
    super(`${invariant}: ${message}`);
    this.name = "VenueSelectionError";
  }
}

const eq = (a: Address, b: Address) => getAddress(a) === getAddress(b);

/**
 * Every token the registry can fund, WBTC last — the safe default for `buildFlashDatas`.
 *
 * Prefer this over deriving the list from the Lens estimate. The engine indexes
 * `estimateLiquidation`'s amounts by its own `debtTokenAddresses`, which `discoverDebtTokens`
 * filters down to *borrowable* reserves, while `LiquidationRouter` indexes the same array by
 * `_getReserves()` — **every** reserve, in spoke order. Those two agree only for as long as the
 * non-borrowable reserves happen to sort last, so a list derived from the engine's indexing is one
 * reserve-ordering change away from naming the wrong tokens.
 *
 * Passing every fundable token sidesteps that entirely: the router looks each one up by token and
 * skips the ones owing nothing ([LiquidationRouter.sol:184-187]). The cost is a few wasted loop
 * iterations, not a wrong `flashDatas`.
 */
export function allFundableTokens(registry: VenueRegistry): Address[] {
  return [...registry.flashSwaps.map((v) => v.token), registry.wbtc];
}

/**
 * Checks a registry is internally consistent, at construction rather than per-liquidation.
 * @throws VenueSelectionError on a duplicate token (I2) or a pool that is not WBTC/<token> (I3).
 */
export function assertRegistryValid(registry: VenueRegistry): void {
  const seen = new Set<string>();
  for (const venue of registry.flashSwaps) {
    const key = getAddress(venue.token);
    if (seen.has(key)) {
      throw new VenueSelectionError("I2", `two flash-swap venues configured for token ${key}`);
    }
    seen.add(key);
    if (eq(venue.token, registry.wbtc)) {
      throw new VenueSelectionError(
        "I1",
        "WBTC must be funded by a flash loan, not a flash swap: a WBTC/x pool would leave a debt in x"
      );
    }
    assertWbtcPairedWith(venue.poolKey, venue.token, registry.wbtc);
  }
}

/**
 * Picks a venue for every token owed, and proves the result settles entirely in WBTC.
 *
 * @param owedTokens Tokens with a non-zero debt. The router recomputes the amounts itself, so only
 *        the identity of each token matters here — but an entry for a token owing nothing is
 *        skipped on-chain, and an entry for a token owing something that we omit is unfunded.
 * @param wbtcPayment The LLP fairness payment, which the router adds to the WBTC borrow.
 * @throws VenueSelectionError if the request cannot be funded with empty `swapDatas`.
 */
export function buildFlashDatas(
  owedTokens: readonly Address[],
  wbtcPayment: bigint,
  registry: VenueRegistry
): FlashData[] {
  const { wbtc } = registry;

  // I2 — at most one entry per token. The router derives the borrow amount from the token, not from
  // the entry, so a duplicate borrows the full debt twice and owes two WBTC debts for one
  // liability. Deduplicating silently would hide a broken caller, so this is an error.
  const seen = new Set<string>();
  for (const token of owedTokens) {
    const key = getAddress(token);
    if (seen.has(key)) {
      throw new VenueSelectionError("I2", `duplicate entry for token ${key}`);
    }
    seen.add(key);
  }

  const needsWbtc = wbtcPayment > 0n || owedTokens.some((t) => eq(t, wbtc));

  const flashDatas: FlashData[] = [];

  for (const token of owedTokens) {
    if (eq(token, wbtc)) continue; // handled once, below, so the fairness payment rides the same entry

    const venue = registry.flashSwaps.find((v) => eq(v.token, token));
    // I1 — no flash-swap venue means the only way to fund this token is a flash loan, which would
    // want the token back and therefore require a `swapDatas` we do not build. Fail loudly rather
    // than emit a `flashDatas` that reverts deep inside a callback.
    if (venue === undefined) {
      throw new VenueSelectionError(
        "I1",
        `no flash-swap venue configured for ${getAddress(token)}; funding it with a flash loan would require a swap back into it`
      );
    }

    // I3 — the venue infers swap direction from the pool key and returns the *other* side as the
    // token owed, without ever checking it is WBTC. A key that is not exactly WBTC/<token> leaves
    // the router owing something it does not hold.
    assertWbtcPairedWith(venue.poolKey, token, wbtc);

    flashDatas.push({
      venueType: VenueType.UniswapV4FlashSwap,
      venueAddress: venue.venueAddress,
      token: getAddress(token),
      swapData: encodePoolKey(venue.poolKey),
    });
  }

  // I4 — the router approves the adapter for the fairness payment whether or not a WBTC venue was
  // supplied, so omitting one does not revert: it quietly spends WBTC the router happens to hold.
  // The registry requires the venue, which is what keeps that unreachable.
  if (needsWbtc) {
    flashDatas.push({
      venueType: registry.wbtcFlashLoan.venueType,
      venueAddress: registry.wbtcFlashLoan.venueAddress,
      token: getAddress(wbtc),
      swapData: "0x",
    });
  }

  if (flashDatas.length === 0) {
    throw new VenueSelectionError("I1", "nothing to fund: no owed tokens and no fairness payment");
  }

  return flashDatas;
}

/** Throws unless `poolKey` is exactly the WBTC/`token` pair, in either currency order. */
export function assertWbtcPairedWith(poolKey: PoolKey, token: Address, wbtc: Address): void {
  const { currency0: c0, currency1: c1 } = poolKey;
  const pairsToken = eq(c0, token) || eq(c1, token);
  const pairsWbtc = eq(c0, wbtc) || eq(c1, wbtc);
  // Both sides must be present *and* distinct: a WBTC/WBTC key would satisfy each check alone.
  if (!pairsToken || !pairsWbtc || eq(c0, c1)) {
    throw new VenueSelectionError(
      "I3",
      `pool ${getAddress(c0)}/${getAddress(c1)} is not WBTC/${getAddress(token)}; the flash swap would leave a debt in a token the router does not hold`
    );
  }
}
