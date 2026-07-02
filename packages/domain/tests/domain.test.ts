import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RESERVE_FLAG,
  bufferAmounts,
  isBorrowableReserve,
  maxWbtcInWithSlippage,
  sequentialPriorityOrder,
} from "../src/index";

describe("bufferAmounts", () => {
  it("applies a 1% buffer by default (matches the original * 10100 / 10000)", () => {
    assert.deepEqual(bufferAmounts([10_000n, 200n]), [10_100n, 202n]);
  });

  it("supports a custom buffer in bps", () => {
    assert.deepEqual(bufferAmounts([10_000n], 250), [10_250n]);
  });

  it("truncates like integer division (no rounding up)", () => {
    // 1n * 10100 / 10000 = 10100/10000 = 1 (floor)
    assert.deepEqual(bufferAmounts([1n]), [1n]);
  });

  it("returns an empty array for no amounts", () => {
    assert.deepEqual(bufferAmounts([]), []);
  });
});

describe("sequentialPriorityOrder", () => {
  it("produces [0, 1, …, n-1] as bigints", () => {
    assert.deepEqual(sequentialPriorityOrder(3), [0n, 1n, 2n]);
  });

  it("is empty for length 0", () => {
    assert.deepEqual(sequentialPriorityOrder(0), []);
  });
});

describe("isBorrowableReserve", () => {
  it("is true only when the BORROWABLE bit is set", () => {
    assert.equal(isBorrowableReserve(RESERVE_FLAG.BORROWABLE), true);
    assert.equal(isBorrowableReserve(RESERVE_FLAG.BORROWABLE | RESERVE_FLAG.PAUSED), true);
    assert.equal(isBorrowableReserve(RESERVE_FLAG.PAUSED | RESERVE_FLAG.FROZEN), false);
    assert.equal(isBorrowableReserve(0), false);
  });
});

describe("maxWbtcInWithSlippage", () => {
  it("adds a bps buffer over the current debt (matches the original)", () => {
    // 1_000_000 + 1% = 1_010_000
    assert.equal(maxWbtcInWithSlippage(1_000_000n, 100), 1_010_000n);
  });

  it("is the debt itself at 0 slippage", () => {
    assert.equal(maxWbtcInWithSlippage(1_000_000n, 0), 1_000_000n);
  });
});
