import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { poolIdOf, v4QuoterAbi } from "./flashVenues";
import { encodePoolKey } from "./uniswapV4";

// Two things the V4 flash-swap source depends on that no compiled artifact carries, pinned to the
// Solidity source instead:
//
// - The quoter's errors. `NotEnoughLiquidity` is the one verdict that a pool cannot fill a size, and
//   `UnexpectedRevertBytes` is the wrapper it arrives in. A drifted signature decodes as neither, so
//   every "cannot fill" would read as an unknown failure. `artifacts.test.ts` compares functions
//   only, and the contracts that declare these errors are not compiled here.
// - `poolIdOf`'s assumption that a pool id hashes the pool key's ABI encoding.
//
// Skips when the v4-periphery submodule is not checked out.

const PERIPHERY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "lib",
  "v4-periphery"
);
const haveSource = existsSync(join(PERIPHERY, "src"));

const source = (path: string) => readFileSync(join(PERIPHERY, path), "utf8");

/** The parameter types of `error <name>(...)` as `file` declares it. */
function declaredErrorTypes(file: string, name: string): string[] {
  const params = source(file).match(new RegExp(`error ${name}\\(([^)]*)\\);`))?.[1];
  if (params === undefined) throw new Error(`could not find \`error ${name}\` in ${file}`);
  return params
    .split(",")
    .map((param) => param.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** The ABI type a declared type encodes as. `PoolId` is a user-defined value type. */
function abiTypeOf(type: string): string {
  if (type !== "PoolId") return type;
  const underlying = source("lib/v4-core/src/types/PoolId.sol").match(/type PoolId is (\w+);/)?.[1];
  if (underlying === undefined) throw new Error("could not find `type PoolId` in PoolId.sol");
  return underlying;
}

type AbiEntry = { type: string; name?: string; inputs?: readonly { type: string }[] };

const abiErrorTypes = (name: string) =>
  (v4QuoterAbi as readonly AbiEntry[])
    .find((entry) => entry.type === "error" && entry.name === name)
    ?.inputs?.map((input) => input.type);

describe("v4QuoterAbi errors match the V4 periphery source", () => {
  it.skipIf(!haveSource)("NotEnoughLiquidity, raised by BaseV4Quoter", () => {
    expect(abiErrorTypes("NotEnoughLiquidity")).toEqual(
      declaredErrorTypes("src/base/BaseV4Quoter.sol", "NotEnoughLiquidity").map(abiTypeOf)
    );
  });

  it.skipIf(!haveSource)("UnexpectedRevertBytes, the wrapper QuoterRevert re-raises with", () => {
    expect(abiErrorTypes("UnexpectedRevertBytes")).toEqual(
      declaredErrorTypes("src/libraries/QuoterRevert.sol", "UnexpectedRevertBytes").map(abiTypeOf)
    );
  });
});

describe("poolIdOf", () => {
  it.skipIf(!haveSource)("hashes the same bytes PoolIdLibrary.toId does", () => {
    // `toId` hashes 0xa0 bytes of the in-memory struct: five static words, which is exactly the
    // ABI encoding. If either side changed length, the ids would stop matching StateView's.
    expect(source("lib/v4-core/src/types/PoolId.sol")).toMatch(/keccak256\(poolKey,\s*0xa0\)/);

    const key = {
      currency0: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      currency1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000",
    } as const;
    expect((encodePoolKey(key).length - 2) / 2).toBe(0xa0);
    expect(poolIdOf(key)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
