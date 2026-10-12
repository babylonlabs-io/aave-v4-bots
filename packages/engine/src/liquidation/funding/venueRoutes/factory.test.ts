import { VenueType } from "@repo/abis";
import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { VenueSelectionError } from "../venues";
import { createReadCache } from "./cache";
import { VENUE_DEFINITIONS, defineVenue } from "./definitions";
import { createVenueSources, parseFlashVenues } from "./factory";
import { AAVE_POOL, MORPHO, SWAP_VENUE, USDC, USDT, WBTC, loanSource, swapSource } from "./testKit";
import type { SourceDeps } from "./types";

const QUOTER = "0x7777777777777777777777777777777777777777" as Address;
const STATE_VIEW = "0x8888888888888888888888888888888888888888" as Address;

const deps: SourceDeps = {
  // Building sources reads nothing; only quoting and `prepare` do.
  publicClient: {} as PublicClient,
  wbtc: WBTC,
  cache: createReadCache,
  quoter: QUOTER,
  stateView: STATE_VIEW,
};

const univ4 = (token: Address, c0: Address, c1: Address, fee = 3000) =>
  `univ4:${SWAP_VENUE}:${token}:${c0}:${c1}:${fee}:60`;

const build = (spec: string, over: Partial<SourceDeps> = {}) =>
  createVenueSources(parseFlashVenues(spec), { ...deps, ...over });

const invariantOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VenueSelectionError);
    return (e as VenueSelectionError).invariant;
  }
  throw new Error("expected a VenueSelectionError");
};

describe("parseFlashVenues", () => {
  it("splits entries on commas and arguments on colons, trimming and dropping blanks", () => {
    expect(parseFlashVenues(` morpho:${MORPHO} ,, aavev3:${AAVE_POOL},`)).toEqual([
      { tag: "morpho", args: [MORPHO], entry: `morpho:${MORPHO}` },
      { tag: "aavev3", args: [AAVE_POOL], entry: `aavev3:${AAVE_POOL}` },
    ]);
  });
});

describe("createVenueSources", () => {
  it("groups sources by token, in configuration order, which becomes their priority", () => {
    const { byToken } = build(
      [
        `morpho:${MORPHO}`,
        univ4(USDC, WBTC, USDC, 3000),
        `aavev3:${AAVE_POOL}`,
        univ4(USDC, WBTC, USDC, 500),
        univ4(USDT, WBTC, USDT),
      ].join(",")
    );

    expect([...byToken.keys()]).toEqual([WBTC, USDC, USDT]);
    expect(byToken.get(WBTC)?.map((s) => [s.id, s.priority])).toEqual([
      [`morpho:${MORPHO}`, 0],
      [`aavev3:${AAVE_POOL}`, 1],
    ]);
    const usdc = byToken.get(USDC) ?? [];
    expect(usdc.map((s) => s.priority)).toEqual([0, 1]);
    expect(new Set(usdc.map((s) => s.id)).size).toBe(2);
  });

  it("keys tokens checksummed, whatever casing the entry used", () => {
    const { byToken } = build(
      `morpho:${MORPHO.toLowerCase()},${univ4(USDC.toLowerCase() as Address, WBTC, USDC)}`
    );

    expect([...byToken.keys()]).toEqual([WBTC, USDC]);
  });

  it("names the known types when an entry's type is unknown", () => {
    expect(() => build(`balancer:${MORPHO}`)).toThrow(
      /unknown venue type "balancer"; known types are morpho, aavev3, univ4/
    );
    // Not fooled by a key every object has.
    expect(() => build(`toString:${MORPHO}`)).toThrow(/unknown venue type/);
  });

  it("names the entry when its arguments are malformed", () => {
    expect(() => build("morpho:")).toThrow(/FLASH_VENUES entry "morpho:": morpho "" is not/);
    expect(() => build(`morpho:${MORPHO}:extra`)).toThrow(/expected morpho:<morpho>/);
    expect(() => build(`univ4:${SWAP_VENUE}:${USDC}:${WBTC}:${USDC}:3.5:60`)).toThrow(
      /fee "3.5" must be an integer/
    );
    expect(() => build(`univ4:${SWAP_VENUE}:${USDC}:${WBTC}:${USDC}:3000:0`)).toThrow(
      /tickSpacing "0"/
    );
    expect(() => build(`univ4:${SWAP_VENUE}:${USDC}:${WBTC}`)).toThrow(/expected univ4:/);
  });

  it("refuses a pool key whose currencies are not in the pool manager's order", () => {
    // WBTC sorts below USDC, so USDC/WBTC names a pool the pool manager could never have created.
    expect(() => build(`morpho:${MORPHO},${univ4(USDC, USDC, WBTC)}`)).toThrow(
      /currency0 .* must sort below currency1/
    );
  });

  it("refuses the same venue twice", () => {
    expect(() => build(`morpho:${MORPHO},morpho:${MORPHO.toLowerCase()}`)).toThrow(
      /repeats venue morpho:/
    );
    // The same pool, written with different casing: one pool id, so one venue.
    expect(() =>
      build(
        `morpho:${MORPHO},${univ4(USDC, WBTC, USDC)},${univ4(USDC.toLowerCase() as Address, WBTC, USDC)}`
      )
    ).toThrow(/repeats venue univ4:/);
  });

  it("I1: refuses a flash swap for WBTC", () => {
    expect(invariantOf(() => build(`morpho:${MORPHO},${univ4(WBTC, WBTC, USDC)}`))).toBe("I1");
  });

  it("I1: refuses a definition that would flash-loan a non-WBTC token", () => {
    const usdcLender = defineVenue<null>({
      tag: "usdcLender",
      kind: "flashLoan",
      venueType: VenueType.Morpho,
      parse: () => null,
      token: () => USDC,
      create: (_config, priority) => ({ ...loanSource("usdc-lender", { priority }), token: USDC }),
    });

    expect(
      invariantOf(() =>
        createVenueSources(parseFlashVenues(`morpho:${MORPHO},usdcLender`), deps, {
          ...VENUE_DEFINITIONS,
          usdcLender,
        })
      )
    ).toBe("I1");
  });

  it("I3: refuses a pool that is not WBTC/<token>, naming the entry", () => {
    const entry = univ4(USDC, USDC, USDT);
    expect(invariantOf(() => build(`morpho:${MORPHO},${entry}`))).toBe("I3");
    expect(() => build(`morpho:${MORPHO},${entry}`)).toThrow(`I3: FLASH_VENUES entry "${entry}": `);
  });

  it("I4: refuses a configuration with no WBTC source", () => {
    expect(invariantOf(() => build(univ4(USDC, WBTC, USDC)))).toBe("I4");
  });

  it("refuses a definition whose source emits another venue type than it declares", () => {
    const liar = defineVenue<null>({
      tag: "liar",
      kind: "flashLoan",
      venueType: VenueType.Morpho,
      parse: () => null,
      token: (_config, wbtc) => wbtc,
      create: (_config, priority) =>
        loanSource("liar", { priority, venueType: VenueType.AaveV3, venueAddress: AAVE_POOL }),
    });

    expect(() =>
      createVenueSources(parseFlashVenues("liar"), deps, { ...VENUE_DEFINITIONS, liar })
    ).toThrow(/emits venue type 0 where its type declares 1/);
  });

  it("refuses a definition whose kind disagrees with how the router dispatches its type", () => {
    const confused = defineVenue<null>({
      tag: "confused",
      kind: "flashSwap",
      venueType: VenueType.Morpho,
      parse: () => null,
      token: () => USDC,
      create: (_config, priority) => swapSource("confused", USDC, { priority }),
    });

    expect(() =>
      createVenueSources(parseFlashVenues("confused"), deps, { ...VENUE_DEFINITIONS, confused })
    ).toThrow(/dispatches venue type 1 as flashLoan/);
  });

  it("surfaces a pool source built without the quoter addresses", () => {
    expect(() =>
      build(`morpho:${MORPHO},${univ4(USDC, WBTC, USDC)}`, { quoter: undefined })
    ).toThrow(/quoter/);
  });

  it("prepares each definition once, with only the entries it parsed", async () => {
    const seen: Record<string, number[]> = {};
    const counting = (tag: string, kind: "flashLoan" | "flashSwap") =>
      defineVenue<number>({
        tag,
        kind,
        venueType: kind === "flashLoan" ? VenueType.Morpho : VenueType.UniswapV4FlashSwap,
        parse: (args) => Number(args[0]),
        token: (_config, wbtc) => (kind === "flashLoan" ? wbtc : USDC),
        create: (config, priority) =>
          kind === "flashLoan"
            ? loanSource(`${tag}-${config}`, { priority })
            : swapSource(`${tag}-${config}`, USDC, { priority }),
        prepare: vi.fn(async (configs: readonly number[]) => {
          seen[tag] = [...(seen[tag] ?? []), ...configs];
        }),
      });
    const loans = counting("loans", "flashLoan");
    const swaps = counting("swaps", "flashSwap");
    const idle = counting("idle", "flashLoan");

    const sources = createVenueSources(parseFlashVenues("loans:1,swaps:2,loans:3"), deps, {
      loans,
      swaps,
      idle,
    });
    await sources.prepare();

    expect(seen).toEqual({ loans: [1, 3], swaps: [2] });
  });
});
