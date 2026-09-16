import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VenueType } from "@repo/abis";
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createReadCache } from "./cache";
import { VENUE_DEFINITIONS } from "./definitions";
import { VENUE_KIND } from "./flashDatas";
import { AAVE_POOL, MORPHO, SWAP_VENUE, USDC, WBTC } from "./testKit";

// `VenueManager._flashLoan` dispatches on `FlashData.venueType` and reverts on any type it has no
// branch for. Nothing off-chain would notice a venue type the contract cannot dispatch until a
// liquidation reverted inside the flash phase, so this reads the dispatch straight from the source
// and holds the venue table to it.

const CONTRACTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "contracts"
);

const dispatched = [
  ...readFileSync(join(CONTRACTS, "VenueManager.sol"), "utf8").matchAll(
    /flashData\.venueType == Types\.VenueType\.(\w+)/g
  ),
].map((m) => m[1]);

const nameOf = (value: number) => Object.entries(VenueType).find(([, v]) => v === value)?.[0];

/** One valid entry per definition. A new definition without one here fails the coverage test. */
const SAMPLE_ARGS: Record<string, string[]> = {
  morpho: [MORPHO],
  aavev3: [AAVE_POOL],
  univ4: [SWAP_VENUE, USDC, WBTC, USDC, "3000", "60"],
};

describe("venue types match what VenueManager dispatches", () => {
  it("finds the dispatch in the contract", () => {
    // Guards the regex: an empty match would make every check below pass vacuously.
    expect(dispatched.length).toBeGreaterThan(0);
  });

  it("maps exactly the dispatched venue types to a kind", () => {
    expect([...VENUE_KIND.keys()].map(nameOf).sort()).toEqual([...dispatched].sort());
  });

  it("gives every definition a dispatched venue type", () => {
    for (const definition of Object.values(VENUE_DEFINITIONS)) {
      expect(dispatched, definition.tag).toContain(nameOf(definition.venueType));
    }
  });

  it("builds a source for every definition that emits exactly its declared type and kind", () => {
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual(Object.keys(VENUE_DEFINITIONS).sort());

    const deps = {
      publicClient: {} as PublicClient,
      wbtc: WBTC,
      cache: createReadCache,
      quoter: SWAP_VENUE,
      stateView: SWAP_VENUE,
    };
    for (const [tag, definition] of Object.entries(VENUE_DEFINITIONS)) {
      const source = definition.parse(SAMPLE_ARGS[tag], WBTC).create(0, deps);
      expect(source.kind, tag).toBe(definition.kind);
      expect(source.flashData().venueType, tag).toBe(definition.venueType);
      expect(VENUE_KIND.get(definition.venueType), tag).toBe(definition.kind);
      expect(source.token as Address, tag).toBe(definition.kind === "flashLoan" ? WBTC : USDC);
    }
  });
});
