import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { VenueSelectionError } from "../venues";
import { planRoute, planToken } from "./planner";
import {
  USDC,
  USDT,
  WBTC,
  loanSource,
  owed,
  quoted,
  swapSource,
  unavailable,
  unknown,
} from "./testKit";
import type { QuoteOutcome } from "./types";

describe("planToken", () => {
  it("picks the source with the lowest WBTC repayment", () => {
    const a = swapSource("a", USDC, { priority: 0 });
    const b = swapSource("b", USDC, { priority: 1 });
    const c = swapSource("c", USDC, { priority: 2 });

    const plan = planToken(owed(USDC, 1_000n), [
      quoted(a, 5_100n),
      quoted(b, 5_020n),
      quoted(c, 5_300n),
    ]);

    expect(plan.kind).toBe("ranked");
    if (plan.kind !== "ranked") return;
    expect(plan.leg.source).toBe(b);
    expect(plan.leg.quotedWbtcRepay).toBe(5_020n);
    expect(plan.leg.amount).toBe(1_000n);
  });

  it("ranks on repayment, not costBps", () => {
    // Two pools at different spot prices: `cheap` looks worse measured against its own spot, yet
    // takes less WBTC for the same amount — and WBTC is what the liquidation actually pays.
    const cheap = swapSource("cheap", USDC, { priority: 1 });
    const pricey = swapSource("pricey", USDC, { priority: 0 });

    const plan = planToken(owed(USDC, 1_000n), [
      quoted(pricey, 5_050n, { costBps: 5n }),
      quoted(cheap, 5_010n, { costBps: 40n }),
    ]);

    expect(plan.kind === "ranked" && plan.leg.source).toBe(cheap);
    expect(plan.kind === "ranked" && plan.leg.costBps).toBe(40n);
  });

  it("skips a cheaper source whose reported liquidity is below the size", () => {
    const shallow = loanSource("shallow", { priority: 0 });
    const deep = loanSource("deep", { priority: 1 });

    const plan = planToken(owed(WBTC, 1_000n), [
      quoted(shallow, 1_000n, { liquidity: 999n }),
      quoted(deep, 1_005n, { liquidity: 50_000n }),
    ]);

    expect(plan.kind === "ranked" && plan.leg.source).toBe(deep);
  });

  it("accepts liquidity exactly at the size, and a source that reports none", () => {
    const exact = loanSource("exact", { priority: 0 });
    const pool = swapSource("pool", USDC);

    expect(planToken(owed(WBTC, 1_000n), [quoted(exact, 1_000n, { liquidity: 1_000n })]).kind).toBe(
      "ranked"
    );
    // A pool has no single maximum-fill figure; its quote succeeding is the proof it fills.
    expect(planToken(owed(USDC, 1_000n), [quoted(pool, 5_000n)]).kind).toBe("ranked");
  });

  it("skips a source that says it cannot fill", () => {
    const dry = swapSource("dry", USDC, { priority: 0 });
    const wet = swapSource("wet", USDC, { priority: 1 });

    const plan = planToken(owed(USDC, 1_000n), [
      unavailable(dry, "NotEnoughLiquidity"),
      quoted(wet, 9_000n),
    ]);

    expect(plan.kind === "ranked" && plan.leg.source).toBe(wet);
  });

  it("breaks a tie on repayment by priority, whatever order the quotes arrive in", () => {
    const first = loanSource("first", { priority: 0 });
    const second = loanSource("second", { priority: 1 });

    const plan = planToken(owed(WBTC, 1_000n), [quoted(second, 1_000n), quoted(first, 1_000n)]);

    expect(plan.kind === "ranked" && plan.leg.source).toBe(first);
  });

  it("falls back to the first unanswered source by priority when no source could answer", () => {
    // An outage in the quoter is not evidence the candidate is unfundable, so it still goes to the
    // probe — marked degraded, with no quoted repayment to show for it.
    const late = swapSource("late", USDC, { priority: 1 });
    const early = swapSource("early", USDC, { priority: 0 });

    const plan = planToken(owed(USDC, 1_000n), [
      unknown(late, new Error("rpc down")),
      unknown(early, new Error("rpc down")),
    ]);

    expect(plan.kind).toBe("degraded");
    if (plan.kind !== "degraded") return;
    expect(plan.leg.source).toBe(early);
    expect(plan.leg.quotedWbtcRepay).toBeUndefined();
  });

  it("degrades onto the unanswered source when the only answer is too small", () => {
    const tooSmall = loanSource("tooSmall", { priority: 0 });
    const silent = loanSource("silent", { priority: 1 });

    const plan = planToken(owed(WBTC, 1_000n), [
      quoted(tooSmall, 1_000n, { liquidity: 10n }),
      unknown(silent, "timeout"),
    ]);

    expect(plan.kind === "degraded" && plan.leg.source).toBe(silent);
  });

  it("prefers a usable quote over a higher-priority source that could not answer", () => {
    // Degrading is only for when nothing usable came back: an answer that fills beats an outage.
    const silent = swapSource("silent", USDC, { priority: 0 });
    const answered = swapSource("answered", USDC, { priority: 1 });

    const plan = planToken(owed(USDC, 1_000n), [
      unknown(silent, new Error("rpc down")),
      quoted(answered, 5_000n),
    ]);

    expect(plan.kind).toBe("ranked");
    expect(plan.kind === "ranked" && plan.leg.source).toBe(answered);
  });

  it("is unfundable only when every source answered and none can fill, naming each", () => {
    const a = swapSource("a", USDC, { priority: 0 });
    const b = swapSource("b", USDC, { priority: 1 });

    const plan = planToken(owed(USDC, 1_000n), [
      unavailable(a, "NotEnoughLiquidity"),
      quoted(b, 5_000n, { liquidity: 1n }),
    ]);

    expect(plan).toEqual({
      kind: "unfundable",
      token: USDC,
      reasons: ["a: NotEnoughLiquidity", "b: liquidity 1 is below 1000"],
    });
  });

  it("keeps every other source's outcome as alternatives", () => {
    const a = swapSource("a", USDC, { priority: 0 });
    const b = swapSource("b", USDC, { priority: 1 });
    const outcomes = [quoted(a, 5_100n), quoted(b, 5_000n)];

    const plan = planToken(owed(USDC, 1_000n), outcomes);

    expect(plan.kind === "ranked" && plan.leg.alternatives).toEqual([outcomes[0]]);
  });

  it("compares tokens case-insensitively", () => {
    const pool = swapSource("pool", USDC);
    const plan = planToken(owed(USDC.toLowerCase() as Address, 1_000n), [quoted(pool, 5_000n)]);

    expect(plan.kind === "ranked" && plan.leg.token).toBe(USDC);
  });

  it("throws I1 when no source is configured for the token", () => {
    // A configuration gap, not a verdict on this candidate — so not `unfundable`.
    const error = (() => {
      try {
        planToken(owed(USDC, 1_000n), []);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(VenueSelectionError);
    expect((error as VenueSelectionError).invariant).toBe("I1");
  });

  it("rejects a non-positive size, a source for another token, and a duplicate id", () => {
    const pool = swapSource("pool", USDC);

    expect(() => planToken(owed(USDC, 0n), [quoted(pool, 1n)])).toThrow(/must be positive/);
    expect(() => planToken(owed(USDT, 1_000n), [quoted(pool, 1n)])).toThrow(/lends/);
    expect(() =>
      planToken(owed(USDC, 1_000n), [quoted(pool, 1n), quoted(swapSource("pool", USDC), 2n)])
    ).toThrow(/duplicate venue id/);
  });
});

describe("planRoute", () => {
  const usdcPool = swapSource("usdc", USDC);
  const usdtPool = swapSource("usdt", USDT);
  const morpho = loanSource("morpho");

  it("plans every owed token and lists the degraded ones", () => {
    const plan = planRoute(
      [owed(USDC, 1_000n), owed(USDT, 2_000n), owed(WBTC, 30n)],
      new Map<Address, readonly QuoteOutcome[]>([
        [USDC, [quoted(usdcPool, 5_000n)]],
        [USDT, [unknown(usdtPool, "rpc down")]],
        [WBTC, [quoted(morpho, 30n)]],
      ])
    );

    expect(plan.kind).toBe("funded");
    if (plan.kind !== "funded") return;
    expect(plan.legs.map((l) => l.source)).toEqual([usdcPool, usdtPool, morpho]);
    expect(plan.degraded).toEqual([USDT]);
  });

  it("is unfundable when any one token is, and names every unfundable token", () => {
    const plan = planRoute(
      [owed(USDC, 1_000n), owed(USDT, 2_000n), owed(WBTC, 30n)],
      new Map<Address, readonly QuoteOutcome[]>([
        [USDC, [unavailable(usdcPool, "NotEnoughLiquidity")]],
        [USDT, [unavailable(usdtPool, "NotEnoughLiquidity")]],
        [WBTC, [quoted(morpho, 30n)]],
      ])
    );

    expect(plan.kind === "unfundable" && plan.tokens.map((t) => t.token)).toEqual([USDC, USDT]);
  });

  it("matches quote keys to owed tokens regardless of checksum casing", () => {
    const plan = planRoute(
      [owed(USDC, 1_000n)],
      new Map<Address, readonly QuoteOutcome[]>([
        [USDC.toLowerCase() as Address, [quoted(usdcPool, 5_000n)]],
      ])
    );

    expect(plan.kind).toBe("funded");
  });

  it("throws I2 on a token owed twice, even when only the casing differs", () => {
    expect(() =>
      planRoute(
        [owed(USDC, 1_000n), owed(USDC.toLowerCase() as Address, 1_000n)],
        new Map([[USDC, [quoted(usdcPool, 5_000n)]]])
      )
    ).toThrow(/^I2/);
  });

  it("throws I2 on quotes keyed twice under different casings", () => {
    expect(() =>
      planRoute(
        [owed(USDC, 1_000n)],
        new Map<Address, readonly QuoteOutcome[]>([
          [USDC, [quoted(usdcPool, 5_000n)]],
          [USDC.toLowerCase() as Address, [quoted(usdcPool, 5_000n)]],
        ])
      )
    ).toThrow(/^I2/);
  });
});
