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
});
