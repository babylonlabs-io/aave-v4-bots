import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLiquidation, applySupply, applyWithdraw } from "./positionAccounting";

describe("positionAccounting", () => {
  it("creates/increments shares on supply", () => {
    assert.equal(applySupply(null, 100n), 100n);
    assert.equal(applySupply(100n, 50n), 150n);
  });

  it("decrements shares on withdraw and removes when emptied", () => {
    assert.equal(applyWithdraw(100n, 30n), 70n);
    assert.equal(applyWithdraw(100n, 100n), null);
    assert.equal(applyWithdraw(100n, 120n), null);
    assert.equal(applyWithdraw(null, 10n), null);
  });

  it("keeps position on partial liquidation and removes on full liquidation", () => {
    assert.equal(applyLiquidation(1_000n, 250n), 750n);
    assert.equal(applyLiquidation(1_000n, 1_000n), null);
    assert.equal(applyLiquidation(1_000n, 1_500n), null);
    assert.equal(applyLiquidation(null, 50n), null);
  });
});
