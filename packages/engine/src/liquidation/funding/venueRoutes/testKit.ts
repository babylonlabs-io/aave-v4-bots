import { type PoolKey, VenueType, type VenueTypeValue, encodePoolKey } from "@repo/abis";
import type { Address } from "viem";
import type { OwedLeg, PlannedLeg, QuoteOutcome, VenueQuote, VenueSource } from "./types";

// Fixtures shared by the venue-route tests. The planner and the builder never quote, so a source
// whose `quote` throws is the honest default: a test that reaches it has a bug.

export const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
export const SWAP_VENUE = "0x1111111111111111111111111111111111111111" as Address;
export const MORPHO = "0x2222222222222222222222222222222222222222" as Address;
export const AAVE_POOL = "0x3333333333333333333333333333333333333333" as Address;
const HOOKS = "0x0000000000000000000000000000000000000000" as Address;

export const poolKey = (a: Address, b: Address, fee = 3000): PoolKey => ({
  currency0: a,
  currency1: b,
  fee,
  tickSpacing: 60,
  hooks: HOOKS,
});

const neverQuoted = async (): Promise<VenueQuote> => {
  throw new Error("the planner must not quote");
};

export function swapSource(
  id: string,
  token: Address,
  over: { priority?: number; poolKey?: PoolKey } = {}
): VenueSource {
  const key = over.poolKey ?? poolKey(WBTC, token);
  return {
    kind: "flashSwap",
    id,
    token,
    priority: over.priority ?? 0,
    quote: neverQuoted,
    flashData: () => ({
      venueType: VenueType.UniswapV4FlashSwap,
      venueAddress: SWAP_VENUE,
      token,
      swapData: encodePoolKey(key),
    }),
  };
}

export function loanSource(
  id: string,
  over: { priority?: number; venueType?: VenueTypeValue; venueAddress?: Address } = {}
): VenueSource {
  return {
    kind: "flashLoan",
    id,
    token: WBTC,
    priority: over.priority ?? 0,
    quote: neverQuoted,
    flashData: () => ({
      venueType: over.venueType ?? VenueType.Morpho,
      venueAddress: over.venueAddress ?? MORPHO,
      token: WBTC,
      swapData: "0x",
    }),
  };
}

export const quoted = (
  source: VenueSource,
  repayWbtc: bigint,
  over: { costBps?: bigint; liquidity?: bigint } = {}
): QuoteOutcome => ({
  status: "quoted",
  source,
  quote: { available: true, repayWbtc, costBps: over.costBps ?? 0n, liquidity: over.liquidity },
});

export const unavailable = (source: VenueSource, reason: string): QuoteOutcome => ({
  status: "quoted",
  source,
  quote: { available: false, reason },
});

export const unknown = (source: VenueSource, error: unknown): QuoteOutcome => ({
  status: "unknown",
  source,
  error,
});

export const owed = (token: Address, amount: bigint): OwedLeg => ({ token, amount });

export const leg = (source: VenueSource, amount = 1_000n): PlannedLeg => ({
  token: source.token,
  amount,
  source,
  alternatives: [],
});
