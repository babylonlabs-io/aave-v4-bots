import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { MIN_PROFIT_REVERT_TAG, VenueType } from "./liquidationRouter";

// Two values the flash path depends on that the ABI cannot carry, so nothing else checks them.
//
// `artifacts.test.ts` pins every function and error signature against the compiled artifact, but an
// enum crosses the boundary as a bare `uint8` and a `private constant` does not appear at all. Both
// of these therefore drift silently, and both fail in directions that are hard to read from the
// outside: the wrong venue ordinal routes a flash callback to the wrong protocol, and a wrong
// sentinel makes the probe stop recognising its own revert so every viable liquidation reads as
// unfundable — a bot that quietly stops trading rather than one that errors.
//
// Read from the Solidity source rather than `out/`, because the source *is* the definition for both:
// the enum's order is its meaning, and the constant is inlined by the compiler.

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts");
const source = (file: string) => readFileSync(join(CONTRACTS, file), "utf8");

describe("liquidationRouter constants match the contracts", () => {
  it("carries VenueType's members in the same order Solidity declares them", () => {
    const body = source("lib/Types.sol").match(/enum VenueType \{([^}]*)\}/)?.[1];
    if (!body) throw new Error("could not find `enum VenueType` in contracts/lib/Types.sol");

    // Ordinals are positional in Solidity, so the declaration order IS the wire format.
    const declared = body
      .split(",")
      .map((member) => member.replace(/\/\/.*$/gm, "").trim())
      .filter(Boolean);

    expect(declared).toEqual(Object.keys(VenueType));
    expect(declared.map((_, i) => i)).toEqual(Object.values(VenueType));
  });

  it("uses the same probe sentinel the router reverts on", () => {
    const declared = source("LiquidationRouter.sol").match(
      /MIN_PROFIT_REVERT_TAG\s*=\s*([^;]+);/
    )?.[1];
    if (!declared)
      throw new Error("could not find `MIN_PROFIT_REVERT_TAG` in LiquidationRouter.sol");

    // The only expression the contract may use for it. Spelled out rather than evaluated, because
    // the point is to notice a change to that line at all — including one that still compiles.
    expect(declared.trim()).toBe("type(uint256).max");
    expect(MIN_PROFIT_REVERT_TAG).toBe(maxUint256);
  });
});
