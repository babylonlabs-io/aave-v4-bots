import { describe, expect, it } from "vitest";
import { maxWbtcInWithSlippage } from "./domain";

describe("maxWbtcInWithSlippage", () => {
  it("adds a bps buffer over the current debt", () => {
    // 1_000_000 + 1% = 1_010_000
    expect(maxWbtcInWithSlippage(1_000_000n, 100)).toBe(1_010_000n);
  });

  it("is the debt itself at 0 slippage", () => {
    expect(maxWbtcInWithSlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  // 10000 bps is 100%: the whole debt again, and the most a tolerance can mean.
  it("doubles the ceiling at the top of the range", () => {
    expect(maxWbtcInWithSlippage(1_000_000n, 10_000)).toBe(2_000_000n);
  });

  // This number is the ceiling the signer authorizes. Past 100% it is no longer a tolerance, and
  // nothing downstream reads as wrong — the payment is authorized against a bound nobody intended.
  it.each([10_001, 20_000, 1_000_000])(
    "refuses %i bps, which is a multiplier not a tolerance",
    (bps) => {
      expect(() => maxWbtcInWithSlippage(1_000_000n, bps)).toThrow(/integer in \[0, 10000\]/);
    }
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %p, which is not a basis-point figure at all",
    (bps) => {
      expect(() => maxWbtcInWithSlippage(1_000_000n, bps)).toThrow(/integer in \[0, 10000\]/);
    }
  );
});
