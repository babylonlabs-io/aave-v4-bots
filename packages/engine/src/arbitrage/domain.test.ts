import { describe, expect, it } from "vitest";
import { isUsableVault, maxWbtcInWithSlippage } from "./domain";

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

// The escrow feed is cast, not parsed, so this guard runs before any `BigInt` conversion.
describe("isUsableVault", () => {
  const vault = {
    vaultId: `0x${"1".repeat(64)}`,
    btcAmount: "100000000",
    currentDebt: "50000000",
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("accepts a well-formed vault", () => {
    expect(isUsableVault(vault)).toBe(true);
  });

  // Nothing reads `createdAt`, so it is not checked.
  it("ignores fields the engine never consumes", () => {
    expect(isUsableVault({ ...vault, createdAt: undefined })).toBe(true);
  });

  // `BigInt("")` is `0n`, so an empty debt would read as nothing owed.
  it("rejects an empty amount, which BigInt would read as zero", () => {
    expect(BigInt("")).toBe(0n); // the trap this guard exists for
    expect(isUsableVault({ ...vault, currentDebt: "" })).toBe(false);
  });

  it.each([
    ["a non-numeric amount", { currentDebt: "abc" }],
    ["a hex amount", { currentDebt: "0x1f" }],
    ["scientific notation", { currentDebt: "1e9" }],
    ["a decimal", { btcAmount: "1.5" }],
    ["a signed amount", { btcAmount: "-1" }],
    ["a padded amount", { btcAmount: " 1 " }],
    ["a number instead of a string", { btcAmount: 100_000_000 }],
    ["a null field", { currentDebt: null }],
    ["a missing field", { currentDebt: undefined }],
    ["a non-hex vaultId", { vaultId: "nope" }],
    ["a bare 0x vaultId", { vaultId: "0x" }],
  ])("rejects %s", (_label, over) => {
    expect(isUsableVault({ ...vault, ...over })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["a number", 1],
    ["an array", []],
  ])("rejects an element that is %s", (_label, element) => {
    expect(isUsableVault(element)).toBe(false);
  });
});
