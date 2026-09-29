import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LENS_HEALTHY_POSITION_REASON } from "./lens";

// Which revert means "healthy" is a choice made in one `require` in the lens, and every other
// revert out of `estimateLiquidation` means the deployment could not answer. Nothing else pins the
// two together: rewording that guard would compile, deploy, and break nothing until the indexer's
// next scan, at which point every healthy position in the table reads as an unexplained fault and
// the bot reports a candidate list it does not trust.
//
// Read from the Solidity source, like `liquidationRouter.test.ts` does for the probe sentinel: the
// guard is the definition, and the artifact does not carry `require` strings at all.
//
// Skips when the contracts submodule is absent, which is the case in the `pnpm test` CI job.
const LENS_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "lib",
  "tbv-contracts",
  "src",
  "applications",
  "aave",
  "AaveAdapterLens.sol"
);

const haveSource = (() => {
  try {
    return statSync(LENS_SOURCE).isFile();
  } catch {
    return false;
  }
})();

describe("lens constants match the contracts", () => {
  it.skipIf(!haveSource)("reverts healthy positions with the reason we match on", () => {
    const source = readFileSync(LENS_SOURCE, "utf8");

    // Anchored on the health-factor check itself, so a *moved* guard fails here rather than passing
    // because the same string survives somewhere else in the file.
    const guard = source.match(
      /healthFactorInit\s*<\s*AaveAdapterLiquidationMathLib\.HEALTH_FACTOR_LIQUIDATION_THRESHOLD,\s*"([^"]+)"/
    )?.[1];
    if (!guard) throw new Error("could not find the health-factor require in AaveAdapterLens.sol");

    expect(guard).toBe(LENS_HEALTHY_POSITION_REASON);
  });
});
