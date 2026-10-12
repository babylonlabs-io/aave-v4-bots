import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { SpokeReserves } from "../../reserves";
import { sizeOwedLegs } from "./legs";
import { USDC, USDT, WBTC } from "./testKit";

const SPOKE = "0x4444444444444444444444444444444444444444" as Address;
const VBTC = "0x5555555555555555555555555555555555555555" as Address;

const topology = (...tokens: Address[]): SpokeReserves => ({
  spoke: SPOKE,
  reserves: tokens.map((token, id) => ({
    id,
    token,
    borrowable: token !== VBTC,
    repayable: token !== VBTC,
  })),
});

describe("sizeOwedLegs", () => {
  it("resolves the debt through its reserve id", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 2n, debtToCover: 300n, wbtcPayment: 0n },
      topology(USDT, WBTC, USDC),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: USDC, amount: 300n }] });
  });

  it("maps by id when a non-borrowable reserve sorts before a borrowable one", () => {
    // A position-based mapping over the borrowable reserves would name USDT's token for USDC's id.
    const legs = sizeOwedLegs(
      { debtReserveId: 1n, debtToCover: 500n, wbtcPayment: 0n },
      topology(VBTC, USDC, USDT),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: USDC, amount: 500n }] });
  });

  it("adds the fairness payment to a WBTC debt in one leg", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 1n, debtToCover: 40n, wbtcPayment: 7n },
      topology(USDC, WBTC),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 47n }] });
  });

  it("puts the debt leg first and the fairness payment's WBTC leg last", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 0n, debtToCover: 100n, wbtcPayment: 9n },
      topology(USDC, WBTC),
      WBTC
    );

    expect(legs).toEqual({
      kind: "sized",
      legs: [
        { token: USDC, amount: 100n },
        { token: WBTC, amount: 9n },
      ],
    });
  });

  it("owes a WBTC leg for a fairness payment alone", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 0n, debtToCover: 0n, wbtcPayment: 9n },
      topology(USDC, WBTC),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 9n }] });
  });

  it("compares the WBTC address case-insensitively", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 0n, debtToCover: 100n, wbtcPayment: 0n },
      topology(WBTC),
      WBTC.toLowerCase() as Address
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 100n }] });
  });

  it("sizes a token listed under two reserve ids from the later id", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 2n, debtToCover: 50n, wbtcPayment: 0n },
      topology(USDC, WBTC, USDC),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: USDC, amount: 50n }] });
  });

  it("skips a candidate with nothing to borrow", () => {
    const legs = sizeOwedLegs(
      { debtReserveId: 0n, debtToCover: 0n, wbtcPayment: 0n },
      topology(USDC),
      WBTC
    );

    expect(legs.kind).toBe("skip");
  });

  it("throws on a reserve id the topology does not have", () => {
    // The candidate and the topology were read against different Spokes; nothing sized from them
    // is trustworthy, so this is a malfunction rather than a skip.
    expect(() =>
      sizeOwedLegs({ debtReserveId: 5n, debtToCover: 1n, wbtcPayment: 0n }, topology(USDC), WBTC)
    ).toThrow(/reserve id 5/);
  });

  it("throws on a negative amount or fairness payment instead of dropping it", () => {
    expect(() =>
      sizeOwedLegs({ debtReserveId: 0n, debtToCover: -1n, wbtcPayment: 0n }, topology(USDC), WBTC)
    ).toThrow(/must not be negative/);
    expect(() =>
      sizeOwedLegs({ debtReserveId: 0n, debtToCover: 1n, wbtcPayment: -1n }, topology(USDC), WBTC)
    ).toThrow(/must not be negative/);
  });
});
