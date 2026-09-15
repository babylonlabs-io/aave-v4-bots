import { describe, expect, it } from "vitest";
import { RESERVE_FLAG, bufferAmount, bufferAmounts, isBorrowableReserve } from "./domain";

describe("bufferAmounts", () => {
  it("applies a 1% buffer by default", () => {
    expect(bufferAmounts([10_000n, 200n])).toEqual([10_100n, 202n]);
  });

  it("supports a custom buffer in bps", () => {
    expect(bufferAmounts([10_000n], 250)).toEqual([10_250n]);
  });

  it("buffers every nonzero amount by at least one unit", () => {
    // Truncation would give 1n * 10100 / 10000 = 1: no buffer at all below 100 units.
    expect(bufferAmounts([1n, 99n])).toEqual([2n, 100n]);
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

  it("buffers every nonzero amount by at least one unit", () => {
    // Every value this produces is an on-chain cap, so an unbuffered small amount reverts on the
    // first upward tick. Truncation would leave 99n at 99n.
    expect(bufferAmount(1n)).toBe(2n);
    expect(bufferAmount(99n)).toBe(100n);
  });

  it("leaves zero at zero", () => {
    // A zero quote is a zero cap. Rounding up must not invent a payment where none was quoted.
    expect(bufferAmount(0n)).toBe(0n);
  });

  it("agrees with plain truncation once the buffer is a whole unit", () => {
    // Above 10_000 / bufferBps the two coincide, which is why no other test in the engine moves.
    expect(bufferAmount(100n)).toBe(101n);
    expect(bufferAmount(5_000n)).toBe(5_050n);
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
