import { describe, expect, it } from "vitest";
import { RESERVE_FLAG, bufferAmounts, isBorrowableReserve, sequentialPriorityOrder } from "./domain";

describe("bufferAmounts", () => {
  it("applies a 1% buffer by default", () => {
    expect(bufferAmounts([10_000n, 200n])).toEqual([10_100n, 202n]);
  });

  it("supports a custom buffer in bps", () => {
    expect(bufferAmounts([10_000n], 250)).toEqual([10_250n]);
  });

  it("truncates like integer division (no rounding up)", () => {
    // 1n * 10100 / 10000 = 1 (floor)
    expect(bufferAmounts([1n])).toEqual([1n]);
  });

  it("returns an empty array for no amounts", () => {
    expect(bufferAmounts([])).toEqual([]);
  });
});

describe("sequentialPriorityOrder", () => {
  it("produces [0, 1, …, n-1] as bigints", () => {
    expect(sequentialPriorityOrder(3)).toEqual([0n, 1n, 2n]);
  });

  it("is empty for length 0", () => {
    expect(sequentialPriorityOrder(0)).toEqual([]);
  });
});

describe("isBorrowableReserve", () => {
  it("is true only when the BORROWABLE bit is set", () => {
    expect(isBorrowableReserve(RESERVE_FLAG.BORROWABLE)).toBe(true);
    expect(isBorrowableReserve(RESERVE_FLAG.BORROWABLE | RESERVE_FLAG.PAUSED)).toBe(true);
    expect(isBorrowableReserve(RESERVE_FLAG.PAUSED | RESERVE_FLAG.FROZEN)).toBe(false);
    expect(isBorrowableReserve(0)).toBe(false);
  });
});
