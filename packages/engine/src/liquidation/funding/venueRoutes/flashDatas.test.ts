import { VenueType, poolKeyAbiParameters } from "@repo/abis";
import { type Address, decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { VenueSelectionError } from "../venues";
import { buildRankedFlashDatas } from "./flashDatas";
import {
  AAVE_POOL,
  MORPHO,
  USDC,
  USDT,
  WBTC,
  leg,
  loanSource,
  poolKey,
  swapSource,
} from "./testKit";
import type { VenueSource } from "./types";

const invariantOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VenueSelectionError);
    return (e as VenueSelectionError).invariant;
  }
  throw new Error("expected a VenueSelectionError");
};

describe("buildRankedFlashDatas", () => {
  const usdc3000 = swapSource("usdc-3000", USDC, { priority: 0 });
  const usdc500 = swapSource("usdc-500", USDC, { priority: 1, poolKey: poolKey(WBTC, USDC, 500) });
  const usdt = swapSource("usdt", USDT);
  const morpho = loanSource("morpho", { priority: 0 });
  const aave = loanSource("aave", {
    priority: 1,
    venueType: VenueType.AaveV3,
    venueAddress: AAVE_POOL,
  });

  const sources = () =>
    new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho, aave]],
      [USDC, [usdc3000, usdc500]],
      [USDT, [usdt]],
    ]);

  it("uses each planned source, and the first-priority source for every other token", () => {
    const flashDatas = buildRankedFlashDatas([leg(usdc500), leg(aave)], sources(), WBTC);

    expect(flashDatas.map((f) => [f.token, f.venueType, f.venueAddress])).toEqual([
      [USDC, VenueType.UniswapV4FlashSwap, usdc500.flashData().venueAddress],
      // Not owed, still present: the router skips it, and a missed token stays funded.
      [USDT, VenueType.UniswapV4FlashSwap, usdt.flashData().venueAddress],
      [WBTC, VenueType.AaveV3, AAVE_POOL],
    ]);
    const [decoded] = decodeAbiParameters(poolKeyAbiParameters, flashDatas[0].swapData);
    expect(decoded.fee).toBe(500);
  });

  it("puts WBTC last even when it is configured first and planned alone", () => {
    const flashDatas = buildRankedFlashDatas([leg(morpho)], sources(), WBTC);

    expect(flashDatas.map((f) => f.token)).toEqual([USDC, USDT, WBTC]);
    expect(flashDatas[2].venueAddress).toBe(MORPHO);
  });

  it("chooses the first source by priority, not by list order, for unplanned tokens", () => {
    const flashDatas = buildRankedFlashDatas(
      [],
      new Map<Address, readonly VenueSource[]>([[WBTC, [aave, morpho]]]),
      WBTC
    );

    expect(flashDatas[0].venueAddress).toBe(MORPHO);
  });

  it("I4: requires a WBTC venue", () => {
    expect(
      invariantOf(() =>
        buildRankedFlashDatas(
          [],
          new Map<Address, readonly VenueSource[]>([[USDC, [usdc3000]]]),
          WBTC
        )
      )
    ).toBe("I4");
  });

  it("I1: refuses a planned token with no configured venue", () => {
    const dai = swapSource("dai", "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address);
    expect(invariantOf(() => buildRankedFlashDatas([leg(dai)], sources(), WBTC))).toBe("I1");
  });

  it("I1: refuses a planned source that is not configured for its token", () => {
    // Right token, valid pool — but not one of the configured sources, so it skipped the checks a
    // source gets when it is built from configuration.
    const stray = swapSource("usdc-stray", USDC, { poolKey: poolKey(WBTC, USDC, 100) });
    expect(invariantOf(() => buildRankedFlashDatas([leg(stray)], sources(), WBTC))).toBe("I1");
  });

  it("I3: refuses swapData that does not decode as a pool key", () => {
    const garbled: VenueSource = {
      ...usdc3000,
      id: "garbled",
      flashData: () => ({ ...usdc3000.flashData(), swapData: "0x1234" }),
    };
    const map = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, [garbled]],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I3");
  });

  it("I1: refuses a token configured with no sources", () => {
    const empty = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, []],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], empty, WBTC))).toBe("I1");
  });

  it("I1: refuses to fund WBTC with a flash swap", () => {
    const wbtcSwap = swapSource("wbtc-swap", WBTC, { poolKey: poolKey(WBTC, USDC) });
    const map = new Map<Address, readonly VenueSource[]>([[WBTC, [wbtcSwap]]]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I1");
  });

  it("I1: refuses to fund a non-WBTC token with a flash loan", () => {
    // A Morpho loan of USDC wants USDC back, and no swap is built to buy it.
    const usdcLoan: VenueSource = {
      ...morpho,
      id: "usdc-loan",
      token: USDC,
      flashData: () => ({ ...morpho.flashData(), token: USDC }),
    };
    const map = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, [usdcLoan]],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I1");
  });

  it("I1: refuses a source whose declared kind disagrees with the venue type it emits", () => {
    // Dispatch on-chain follows the emitted venue type alone, so the declaration must match it.
    const liar: VenueSource = { ...morpho, id: "liar", kind: "flashSwap" };
    const map = new Map<Address, readonly VenueSource[]>([[WBTC, [liar]]]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I1");
  });

  it("I1: refuses a venue type the router does not dispatch", () => {
    const undispatched = loanSource("v4-loan", { venueType: VenueType.UniswapV4FlashLoan });
    const map = new Map<Address, readonly VenueSource[]>([[WBTC, [undispatched]]]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I1");
  });

  it("I2: refuses an entry naming a different token than it was chosen for", () => {
    const wrongToken: VenueSource = {
      ...usdc3000,
      id: "wrong",
      flashData: () => usdt.flashData(),
    };
    const map = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, [wrongToken]],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I2");
  });

  it("I2: refuses a token planned twice or keyed twice", () => {
    expect(
      invariantOf(() => buildRankedFlashDatas([leg(usdc3000), leg(usdc500)], sources(), WBTC))
    ).toBe("I2");
    const twice = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, [usdc3000]],
      [USDC.toLowerCase() as Address, [usdc500]],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], twice, WBTC))).toBe("I2");
  });

  it("I3: refuses a pool that is not WBTC/<token>", () => {
    const misPaired = swapSource("usdc-usdt", USDC, { poolKey: poolKey(USDC, USDT) });
    const map = new Map<Address, readonly VenueSource[]>([
      [WBTC, [morpho]],
      [USDC, [misPaired]],
    ]);
    expect(invariantOf(() => buildRankedFlashDatas([], map, WBTC))).toBe("I3");
  });

  it("checksums tokens, whatever casing the map and the WBTC address use", () => {
    const map = new Map<Address, readonly VenueSource[]>([
      [WBTC.toLowerCase() as Address, [morpho]],
      [USDC.toLowerCase() as Address, [usdc3000]],
    ]);

    const flashDatas = buildRankedFlashDatas([], map, WBTC.toLowerCase() as Address);

    expect(flashDatas.map((f) => f.token)).toEqual([USDC, WBTC]);
  });
});
