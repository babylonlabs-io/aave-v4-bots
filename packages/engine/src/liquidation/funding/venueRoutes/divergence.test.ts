import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { quoteDivergences } from "./divergence";
import { MORPHO, SWAP_VENUE, USDC, USDT, WBTC, leg, loanSource, swapSource } from "./testKit";
import type { PlannedLeg } from "./types";

const quotedLeg = (source: PlannedLeg["source"], quotedWbtcRepay: bigint): PlannedLeg => ({
  ...leg(source),
  quotedWbtcRepay,
});

const debt = (venue: Address, amount: bigint) => ({ token: WBTC, venue, amount });

describe("quoteDivergences", () => {
  const usdcPool = swapSource("usdc", USDC);
  const usdtPool = swapSource("usdt", USDT);
  const morpho = loanSource("morpho");

  it("sums two pools on one swap venue, since the probe reports only the venue", () => {
    const legs = [quotedLeg(usdcPool, 400n), quotedLeg(usdtPool, 500n), quotedLeg(morpho, 50n)];
    // One debt per pool, both naming the same swap venue: 950 probed against 900 quoted.
    const debts = [debt(SWAP_VENUE, 450n), debt(SWAP_VENUE, 500n), debt(MORPHO, 50n)];

    expect(quoteDivergences(legs, debts)).toEqual([
      { venue: SWAP_VENUE, quotedWbtc: 900n, probedWbtc: 950n },
    ]);
  });

  it("reports nothing when every venue came back at or under its quote", () => {
    // The usual case: quotes are sized at buffered amounts, above what the router borrows.
    const legs = [quotedLeg(usdcPool, 400n), quotedLeg(morpho, 50n)];

    expect(quoteDivergences(legs, [debt(SWAP_VENUE, 400n), debt(MORPHO, 49n)])).toEqual([]);
  });

  it("leaves out a venue with any unquoted leg, which has nothing to compare against", () => {
    const legs = [quotedLeg(usdcPool, 1n), leg(usdtPool)];

    expect(quoteDivergences(legs, [debt(SWAP_VENUE, 1_000n)])).toEqual([]);
  });

  it("reads a venue the probe reports no debt for as zero, not as a divergence", () => {
    expect(quoteDivergences([quotedLeg(morpho, 50n)], [])).toEqual([]);
  });

  it("matches venue addresses regardless of checksum casing", () => {
    const legs = [quotedLeg(morpho, 50n)];

    expect(quoteDivergences(legs, [debt(MORPHO.toLowerCase() as Address, 60n)])).toEqual([
      { venue: MORPHO, quotedWbtc: 50n, probedWbtc: 60n },
    ]);
  });
});
