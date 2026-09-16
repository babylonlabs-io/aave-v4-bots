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
  it("resolves each amount through its reserve id, non-WBTC tokens first in id order, WBTC last", () => {
    // The preview lists amounts in the order it costed them, not by id; the legs come out by id.
    const legs = sizeOwedLegs(
      { debtReserveIds: [2n, 0n, 1n], debtToCoverAmounts: [300n, 100n, 200n], wbtcPayment: 0n },
      topology(USDT, WBTC, USDC),
      WBTC
    );

    expect(legs).toEqual({
      kind: "sized",
      legs: [
        { token: USDT, amount: 100n },
        { token: USDC, amount: 300n },
        { token: WBTC, amount: 200n },
      ],
    });
  });

  it("maps by id when a non-borrowable reserve sorts before a borrowable one", () => {
    // A position-based mapping over the borrowable reserves would name USDT's token for USDC's id.
    const legs = sizeOwedLegs(
      { debtReserveIds: [1n], debtToCoverAmounts: [500n], wbtcPayment: 0n },
      topology(VBTC, USDC, USDT),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: USDC, amount: 500n }] });
  });

  it("adds the fairness payment to the WBTC leg", () => {
    const legs = sizeOwedLegs(
      { debtReserveIds: [0n, 1n], debtToCoverAmounts: [100n, 40n], wbtcPayment: 7n },
      topology(USDC, WBTC),
      WBTC
    );

    expect(legs.kind === "sized" && legs.legs.at(-1)).toEqual({ token: WBTC, amount: 47n });
  });

  it("owes a WBTC leg for a fairness payment alone", () => {
    const legs = sizeOwedLegs(
      { debtReserveIds: [0n], debtToCoverAmounts: [100n], wbtcPayment: 9n },
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

  it("leaves out zero amounts", () => {
    const legs = sizeOwedLegs(
      { debtReserveIds: [0n, 1n], debtToCoverAmounts: [0n, 100n], wbtcPayment: 0n },
      topology(USDC, USDT),
      WBTC
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: USDT, amount: 100n }] });
  });

  it("compares the WBTC address case-insensitively", () => {
    const legs = sizeOwedLegs(
      { debtReserveIds: [0n], debtToCoverAmounts: [100n], wbtcPayment: 0n },
      topology(WBTC),
      WBTC.toLowerCase() as Address
    );

    expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 100n }] });
  });

  describe("a token listed under two reserve ids", () => {
    // The router sizes the borrow from the first reserve with that token, but the adapter pulls
    // every reserve's debt — so any debt beyond the first reserve is unborrowed.

    it("skips a candidate owing it on both ids", () => {
      const legs = sizeOwedLegs(
        { debtReserveIds: [0n, 2n], debtToCoverAmounts: [100n, 50n], wbtcPayment: 0n },
        topology(USDC, WBTC, USDC),
        WBTC
      );

      expect(legs.kind).toBe("skip");
      expect(legs.kind === "skip" && legs.reason).toMatch(
        /reserve 2, but reserve 0 lists it first/
      );
    });

    it("sizes a candidate owing it only on the first id, which the router borrows in full", () => {
      const legs = sizeOwedLegs(
        { debtReserveIds: [0n], debtToCoverAmounts: [100n], wbtcPayment: 0n },
        topology(USDC, WBTC, USDC),
        WBTC
      );

      expect(legs).toEqual({ kind: "sized", legs: [{ token: USDC, amount: 100n }] });
    });

    it("sizes WBTC owed only on the first WBTC reserve when there is no fairness payment", () => {
      const legs = sizeOwedLegs(
        { debtReserveIds: [0n], debtToCoverAmounts: [100n], wbtcPayment: 0n },
        topology(WBTC, USDC, WBTC),
        WBTC
      );

      expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 100n }] });
    });

    it("skips WBTC owed on the first WBTC reserve with a fairness payment", () => {
      // The later WBTC reserve's approval (the payment alone) replaces the first one's (debt plus
      // payment), so the adapter cannot pull the debt.
      const legs = sizeOwedLegs(
        { debtReserveIds: [0n], debtToCoverAmounts: [100n], wbtcPayment: 5n },
        topology(WBTC, USDC, WBTC),
        WBTC
      );

      expect(legs.kind).toBe("skip");
      expect(legs.kind === "skip" && legs.reason).toMatch(/with a fairness payment/);
    });

    it("sizes a fairness payment alone when two reserves share WBTC", () => {
      // Every WBTC reserve approves the payment alone, so the last approval still covers it.
      const legs = sizeOwedLegs(
        { debtReserveIds: [1n], debtToCoverAmounts: [100n], wbtcPayment: 5n },
        topology(WBTC, USDC, WBTC),
        WBTC
      );

      expect(legs).toEqual({
        kind: "sized",
        legs: [
          { token: USDC, amount: 100n },
          { token: WBTC, amount: 5n },
        ],
      });
    });

    it("skips a candidate owing it only on the later id, where the router's lookup reads zero", () => {
      const legs = sizeOwedLegs(
        { debtReserveIds: [2n], debtToCoverAmounts: [50n], wbtcPayment: 0n },
        topology(USDC, WBTC, USDC),
        WBTC
      );

      expect(legs.kind).toBe("skip");
    });

    it("does not skip a candidate that owes nothing on that token", () => {
      const legs = sizeOwedLegs(
        { debtReserveIds: [1n, 2n], debtToCoverAmounts: [40n, 0n], wbtcPayment: 0n },
        topology(USDC, WBTC, USDC),
        WBTC
      );

      expect(legs).toEqual({ kind: "sized", legs: [{ token: WBTC, amount: 40n }] });
    });
  });

  it("skips a candidate with nothing to borrow", () => {
    const legs = sizeOwedLegs(
      { debtReserveIds: [0n], debtToCoverAmounts: [0n], wbtcPayment: 0n },
      topology(USDC),
      WBTC
    );

    expect(legs.kind).toBe("skip");
  });

  it("throws on a reserve id the topology does not have", () => {
    // The candidate and the topology were read against different Spokes; nothing sized from them
    // is trustworthy, so this is a malfunction rather than a skip.
    expect(() =>
      sizeOwedLegs(
        { debtReserveIds: [5n], debtToCoverAmounts: [1n], wbtcPayment: 0n },
        topology(USDC),
        WBTC
      )
    ).toThrow(/reserve id 5/);
  });

  it("throws when ids and amounts do not pair up", () => {
    expect(() =>
      sizeOwedLegs(
        { debtReserveIds: [0n, 1n], debtToCoverAmounts: [1n], wbtcPayment: 0n },
        topology(USDC, USDT),
        WBTC
      )
    ).toThrow(/pairs 2 reserve ids with 1 amounts/);
  });

  it("throws on a reserve id listed twice, rather than summing a borrow the router never makes", () => {
    // The router writes each pair into one slot per reserve, so a repeated id keeps one amount.
    expect(() =>
      sizeOwedLegs(
        { debtReserveIds: [0n, 0n], debtToCoverAmounts: [1n, 2n], wbtcPayment: 0n },
        topology(USDC),
        WBTC
      )
    ).toThrow(/appears twice/);
  });

  it("throws on a negative amount or fairness payment instead of dropping it", () => {
    expect(() =>
      sizeOwedLegs(
        { debtReserveIds: [0n], debtToCoverAmounts: [-1n], wbtcPayment: 0n },
        topology(USDC),
        WBTC
      )
    ).toThrow(/must not be negative/);
    expect(() =>
      sizeOwedLegs(
        { debtReserveIds: [0n], debtToCoverAmounts: [1n], wbtcPayment: -1n },
        topology(USDC),
        WBTC
      )
    ).toThrow(/must not be negative/);
  });
});
