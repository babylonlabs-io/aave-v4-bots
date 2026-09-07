import { describe, expect, it } from "vitest";
import { RESERVE_FLAG, bufferAmount, bufferAmounts, isBorrowableReserve } from "./domain";

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

describe("bufferAmount", () => {
  it("applies a 1% buffer by default", () => {
    expect(bufferAmount(10_000n)).toBe(10_100n);
  });

  it("supports a custom buffer in bps", () => {
    expect(bufferAmount(10_000n, 250)).toBe(10_250n);
  });

  it("truncates like integer division (no rounding up)", () => {
    expect(bufferAmount(1n)).toBe(1n);
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
