import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adapterAbi,
  arbitrageRouterAbi,
  lensAbi,
  liquidationRouterAbi,
  spokeAbi,
  uniswapV4SwapVenueAbi,
  v4QuoterAbi,
  vaultSwapAbi,
} from "./index";

// These ABIs are hand-maintained subsets of the compiled contracts, and nothing else checks them:
// a wrong argument type or a re-ordered tuple component still compiles, still type-checks, and
// still encodes — it just encodes the wrong bytes, and only fails against a real chain. Drift here
// has repeatedly surfaced as a runtime mystery rather than a build error, so this pins every entry
// to the artifact `forge build` produces.
//
// Skips when `out/` is absent, which is the case in the `pnpm test` CI job (it does not run forge).
// Run `forge build` first to exercise it.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "out");

type AbiParam = { type: string; components?: readonly AbiParam[] };
type AbiEntry = { type: string; name?: string; inputs?: readonly AbiParam[] };

/**
 * Canonical ABI type of one parameter, with tuples expanded to `(a,b)` and `(a,b)[]`.
 *
 * Expanding is the entire point: this ABI is mostly tuples, and a param's `.type` is the literal
 * string `"tuple"` regardless of what is inside it. Comparing on that alone would treat
 * `{borrower, minWbtcProfit: uint256}` and `{borrower, minWbtcProfit: uint128}` as identical — the
 * exact substitution that silently encodes the wrong bytes.
 */
const paramType = (p: AbiParam): string =>
  p.type.startsWith("tuple")
    ? `(${(p.components ?? []).map(paramType).join(",")})${p.type.slice("tuple".length)}`
    : p.type;

/** The `type name(argType,...)` signature — the part of an entry that decides its selector. */
const signature = (e: AbiEntry) =>
  `${e.type} ${e.name}(${(e.inputs ?? []).map(paramType).join(",")})`;

function findArtifact(contract: string): string | undefined {
  const matches: string[] = [];
  const stack = [OUT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (entry === `${contract}.json`) matches.push(path);
    }
  }
  // Two artifacts under one name — the same contract vendored by two dependencies, say — would make
  // the pin depend on the order the directory walk happens to visit them in.
  if (matches.length > 1) {
    throw new Error(`${contract}.json is ambiguous under out/: ${matches.join(", ")}`);
  }
  return matches[0];
}

function artifactSignatures(contract: string, artifactPath?: string): Set<string> | undefined {
  const path = artifactPath === undefined ? findArtifact(contract) : join(OUT_DIR, artifactPath);
  if (path === undefined || !existsSync(path)) return undefined;
  const abi = JSON.parse(readFileSync(path, "utf8")).abi as AbiEntry[];
  return new Set(abi.map(signature));
}

/** `[export, abi, contract, artifact path under out/ — when a name alone is not specific enough]`. */
const CASES: ReadonlyArray<[string, readonly AbiEntry[], string, string?]> = [
  ["vaultSwapAbi", vaultSwapAbi, "BTCVaultSwap"],
  ["adapterAbi", adapterAbi, "AaveAdapter"],
  ["lensAbi", lensAbi, "AaveAdapterLiquidationPreview"],
  ["spokeAbi", spokeAbi, "Spoke"],
  ["liquidationRouterAbi", liquidationRouterAbi, "LiquidationRouter"],
  ["arbitrageRouterAbi", arbitrageRouterAbi, "ArbitrageRouter"],
  // The interface, not `V4Quoter`: forge builds only what this repo imports, and the fork tests
  // import the interface. It inherits `poolManager`, so the one artifact covers every function.
  // Located by path, because v4-periphery is vendored twice (once more inside universal-router)
  // and a name could resolve to either copy. Its errors are pinned to the Solidity source in
  // `flashVenues.test.ts`, since this test compares functions only.
  ["v4QuoterAbi", v4QuoterAbi, "IV4Quoter", "IV4Quoter.sol/IV4Quoter.json"],
  [
    "uniswapV4SwapVenueAbi",
    uniswapV4SwapVenueAbi,
    "UniswapV4SwapVenue",
    "UniswapV4SwapVenue.sol/UniswapV4SwapVenue.json",
  ],
];

describe("@repo/abis matches the compiled contracts", () => {
  const haveArtifacts = (() => {
    try {
      return statSync(OUT_DIR).isDirectory();
    } catch {
      return false;
    }
  })();

  for (const [exportName, abi, contract, artifactPath] of CASES) {
    it.skipIf(!haveArtifacts)(`${exportName} -> ${contract}`, () => {
      const real = artifactSignatures(contract, artifactPath);
      expect(real, `no compiled artifact for ${contract}`).toBeDefined();

      // Constructors are not part of what we call, and we deliberately carry only a subset — so
      // this is one-directional: everything we declare must exist, not the reverse.
      //
      // Errors are excluded because every ABI now spreads in `protocolErrorsAbi`, whose entries
      // belong to the whole call graph rather than to this one contract — `swapWbtcForVault`
      // reverting with an ApplicationRegistry error is the normal case, not drift. They are pinned
      // to their own artifacts in `protocolErrors.test.ts` instead.
      const missing = abi
        .filter((e) => e.type !== "constructor" && e.type !== "error")
        .map(signature)
        .filter((s) => !real?.has(s));

      expect(missing).toEqual([]);
    });
  }

  it.skipIf(!haveArtifacts)("liquidationRouterAbi carries the probe's error", () => {
    // Called out separately because losing it degrades silently: the probe still runs, the revert
    // still happens, and viem just cannot tell us what it said.
    const beloved = liquidationRouterAbi.find(
      (e) => e.type === "error" && e.name === "BelovedError"
    );
    expect(beloved).toBeDefined();
    expect(artifactSignatures("LiquidationRouter")).toContain(
      signature(beloved as unknown as AbiEntry)
    );
  });
});
