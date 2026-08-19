import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  adapterAbi,
  arbitrageRouterAbi,
  lensAbi,
  liquidationRouterAbi,
  protocolErrorsAbi,
  spokeAbi,
  vaultSwapAbi,
} from "./index";

// `protocolErrorsAbi` is generated (scripts/gen-protocol-errors.mjs) but committed, so nothing
// regenerates it on a contracts bump — this is what notices. It is the bidirectional counterpart to
// artifacts.test.ts: that file checks the functions and events we declare still exist, this one
// checks the error catalogue is neither stale nor incomplete.
//
// Skips when `out/` is absent, which is the case in the `pnpm test` CI job (it does not run forge).
// Run `forge build` first to exercise it.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "out");

type AbiParam = { name?: string; type: string; components?: readonly AbiParam[] };
type AbiEntry = { type: string; name?: string; inputs?: readonly AbiParam[] };

const paramType = (p: AbiParam): string =>
  p.type.startsWith("tuple")
    ? `(${(p.components ?? []).map(paramType).join(",")})${p.type.slice("tuple".length)}`
    : p.type;

const signature = (e: AbiEntry) => `${e.name}(${(e.inputs ?? []).map(paramType).join(",")})`;

function findArtifact(contract: string): string | undefined {
  const stack = [OUT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (entry === `${contract}.json`) return path;
    }
  }
  return undefined;
}

/** The contract list the generator reads; kept in step with it by hand. */
const SOURCE_CONTRACTS = [
  "BTCVaultSwap",
  "AaveAdapter",
  "AaveAdapterLens",
  "LiquidationRouter",
  "ArbitrageRouter",
  "Spoke",
  "BTCVaultRegistry",
  "ApplicationRegistry",
  "AaveAdapterPositionProxy",
  // Only compiled when built by path — nothing in this repo imports it — so it is allowed to be
  // absent here. See the generator's header.
  "BorrowDelegationPositionAccount",
] as const;

const declared = protocolErrorsAbi.map((e) => signature(e as AbiEntry));

describe("protocolErrorsAbi", () => {
  const haveArtifacts = (() => {
    try {
      return statSync(OUT_DIR).isDirectory();
    } catch {
      return false;
    }
  })();

  // Merging the call graph's errors into one list is only sound while no two of them share a
  // selector: viem decodes by selector and takes the first match, so a collision would silently
  // report the wrong error name with the wrong args.
  it("has no colliding selectors", () => {
    const bySelector = new Map<string, string>();
    for (const sig of declared) {
      const selector = toFunctionSelector(sig);
      const seen = bySelector.get(selector);
      expect(seen ?? sig, `selector ${selector} is shared by two errors`).toBe(sig);
      bySelector.set(selector, sig);
    }
  });

  it("carries the error an unregistered vault keeper reverts with", () => {
    // The one that motivated this file: raised by ApplicationRegistry, surfaced by a BTCVaultSwap
    // call, and therefore invisible to any per-contract ABI.
    expect(declared).toContain("UnauthorizedVaultKeeper()");
    expect(toFunctionSelector("UnauthorizedVaultKeeper()")).toBe("0xc2732b47");
  });

  // Both directions against the artifacts. Stale entries would decode a selector that no longer
  // exists; missing ones are the original bug, back again for whatever the bump added.
  it.skipIf(!haveArtifacts)("matches the compiled artifacts in both directions", () => {
    const fromArtifacts = new Set<string>();
    const missingArtifacts: string[] = [];
    for (const contract of SOURCE_CONTRACTS) {
      const path = findArtifact(contract);
      if (path === undefined) {
        missingArtifacts.push(contract);
        continue;
      }
      const abi = JSON.parse(readFileSync(path, "utf8")).abi as AbiEntry[];
      for (const entry of abi) if (entry.type === "error") fromArtifacts.add(signature(entry));
    }
    expect(missingArtifacts.length, "every artifact is missing — check OUT_DIR").toBeLessThan(
      SOURCE_CONTRACTS.length
    );

    // Every artifact error is declared. This is what a contracts bump trips.
    expect([...fromArtifacts].filter((s) => !declared.includes(s)).sort()).toEqual([]);

    // Every declared error still exists. Entries belonging to a contract that was not compiled
    // cannot be checked, so they are only held to their name — a re-typed error still fails.
    const names = new Set([...fromArtifacts].map((s) => s.slice(0, s.indexOf("("))));
    expect(
      declared.filter((s) => names.has(s.slice(0, s.indexOf("("))) && !fromArtifacts.has(s))
    ).toEqual([]);
  });

  // A new ABI that forgets the spread is exactly the failure this package is meant to prevent, and
  // it would show up only as an undecodable selector in production.
  it.each([
    ["vaultSwapAbi", vaultSwapAbi],
    ["adapterAbi", adapterAbi],
    ["lensAbi", lensAbi],
    ["spokeAbi", spokeAbi],
    ["liquidationRouterAbi", liquidationRouterAbi],
    ["arbitrageRouterAbi", arbitrageRouterAbi],
  ])("%s spreads in the full error catalogue", (_name, abi) => {
    const present = new Set(
      (abi as readonly AbiEntry[]).filter((e) => e.type === "error").map(signature)
    );
    expect(declared.filter((s) => !present.has(s))).toEqual([]);
  });
});
