import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LENS_HEALTHY_POSITION_ERROR } from "./lens";
import { protocolErrorsAbi } from "./protocolErrors";

// Which error means "healthy" is a choice made in one `require` in the preview, and every other
// revert out of `estimateLiquidation` means the deployment could not answer. Nothing else pins the
// two together: swapping the error in that guard for another one that is equally present in
// `protocolErrorsAbi` would compile, deploy, and break nothing until the indexer's next scan, at
// which point every healthy position in the table reads as an unexplained fault and the bot reports
// a candidate list it does not trust.
//
// Read from the Solidity source, like `liquidationRouter.test.ts` does for the probe sentinel: the
// guard is the definition, and the artifact only says the error exists, not what it means.
//
// Skips when the contracts submodule is absent, which is the case in the `pnpm test` CI job.
const PREVIEW_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "lib",
  "tbv-contracts",
  "src",
  "applications",
  "aave",
  "AaveAdapterLiquidationPreview.sol"
);

const haveSource = (() => {
  try {
    return statSync(PREVIEW_SOURCE).isFile();
  } catch {
    return false;
  }
})();

describe("lens constants match the contracts", () => {
  it.skipIf(!haveSource)("reverts healthy positions with the error we match on", () => {
    const source = readFileSync(PREVIEW_SOURCE, "utf8");

    // Anchored on the health-factor check itself, so a *moved* guard fails here rather than passing
    // because the same error name survives somewhere else in the file.
    const guard = source.match(
      /healthFactor\s*<\s*AaveAdapterLiquidationMathLib\.HEALTH_FACTOR_LIQUIDATION_THRESHOLD,\s*AdapterErrors\.(\w+)\(\)/
    )?.[1];
    if (!guard)
      throw new Error(
        "could not find the health-factor require in AaveAdapterLiquidationPreview.sol"
      );

    expect(guard).toBe(LENS_HEALTHY_POSITION_ERROR);
  });

  it("declares that error, so viem can name it", () => {
    // `isHealthyPositionRevert` matches on the decoded `errorName`, which viem only produces for a
    // selector it finds in the ABI it was handed. Missing here, every healthy position decodes to a
    // bare selector and is counted as a fault instead.
    const names = protocolErrorsAbi.map((e) => e.name);
    expect(names).toContain(LENS_HEALTHY_POSITION_ERROR);
  });
});
