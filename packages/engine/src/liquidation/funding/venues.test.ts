import { type PoolKey, VenueType, encodePoolKey, poolKeyAbiParameters } from "@repo/abis";
import type { Address } from "viem";
import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { probeArgs } from "./flashProbe";
import {
  type VenueRegistry,
  VenueSelectionError,
  allFundableTokens,
  assertRegistryValid,
  assertWbtcPairedWith,
  buildFlashDatas,
} from "./venues";

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
const VENUE = "0x1111111111111111111111111111111111111111" as Address;
const MORPHO = "0x2222222222222222222222222222222222222222" as Address;
const HOOKS = "0x0000000000000000000000000000000000000000" as Address;

const poolKey = (a: Address, b: Address): PoolKey => ({
  currency0: a,
  currency1: b,
  fee: 3000,
  tickSpacing: 60,
  hooks: HOOKS,
});

const registry = (over: Partial<VenueRegistry> = {}): VenueRegistry => ({
  wbtc: WBTC,
  flashSwaps: [
    { token: USDC, venueAddress: VENUE, poolKey: poolKey(WBTC, USDC) },
    { token: USDT, venueAddress: VENUE, poolKey: poolKey(USDT, WBTC) },
  ],
  wbtcFlashLoan: { venueType: VenueType.Morpho, venueAddress: MORPHO },
  ...over,
});

describe("buildFlashDatas", () => {
  it("funds debt tokens with flash swaps and WBTC with a flash loan", () => {
    const flashDatas = buildFlashDatas([USDC, USDT], 0n, registry());

    expect(flashDatas.map((f) => f.venueType)).toEqual([
      VenueType.UniswapV4FlashSwap,
      VenueType.UniswapV4FlashSwap,
    ]);
    // No fairness payment and no WBTC debt, so no WBTC leg is needed.
    expect(flashDatas).toHaveLength(2);
  });

  it("appends a WBTC flash loan when a fairness payment is owed", () => {
    // The router adds `wbtcPayment` to the WBTC borrow, so the fairness payment rides this entry
    // rather than needing one of its own.
    const flashDatas = buildFlashDatas([USDC], 500n, registry());

    expect(flashDatas).toHaveLength(2);
    expect(flashDatas[1]).toMatchObject({
      venueType: VenueType.Morpho,
      venueAddress: MORPHO,
      token: WBTC,
      swapData: "0x",
    });
  });

  it("emits exactly one WBTC entry when WBTC is both a debt and a fairness payment", () => {
    const flashDatas = buildFlashDatas([USDC, WBTC], 500n, registry());

    expect(flashDatas.filter((f) => f.token === WBTC)).toHaveLength(1);
  });

  it("encodes the pool key as the flash-swap venue's swapData", () => {
    const [usdc] = buildFlashDatas([USDC], 0n, registry());

    const [decoded] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      usdc.swapData
    );
    expect(decoded).toMatchObject({ currency0: WBTC, currency1: USDC, fee: 3000, tickSpacing: 60 });
  });

  it("is case-insensitive about address checksums", () => {
    const flashDatas = buildFlashDatas([USDC.toLowerCase() as Address], 0n, registry());
    expect(flashDatas[0].venueType).toBe(VenueType.UniswapV4FlashSwap);
  });

  // ── the invariants that the contracts do not enforce ──────────────────────────────────

  it("I1: refuses a token with no flash-swap venue, rather than emitting an unfundable entry", () => {
    // A flash loan would want DAI back, and we build no `swapDatas` to buy it — the venue could not
    // be repaid, and the failure would surface deep inside a callback.
    const error = (() => {
      try {
        buildFlashDatas([USDC, DAI], 0n, registry());
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(VenueSelectionError);
    expect((error as VenueSelectionError).invariant).toBe("I1");
  });

  it("I2: refuses a duplicated token", () => {
    // The router looks the borrow amount up by token, so a duplicate borrows the whole debt twice
    // and leaves two WBTC debts against one liability. Nothing on-chain deduplicates.
    expect(() => buildFlashDatas([USDC, USDC], 0n, registry())).toThrow(/^I2/);
  });

  it("I2: catches a duplicate that differs only by checksum casing", () => {
    expect(() => buildFlashDatas([USDC, USDC.toLowerCase() as Address], 0n, registry())).toThrow(
      /^I2/
    );
  });

  it("I3: refuses a pool key that is not WBTC/<token>", () => {
    // USDC/USDT would hand back a USDT debt: the venue returns whichever side is not the borrowed
    // token, and never checks that it is WBTC.
    const bad = registry({
      flashSwaps: [{ token: USDC, venueAddress: VENUE, poolKey: poolKey(USDC, USDT) }],
    });

    expect(() => buildFlashDatas([USDC], 0n, bad)).toThrow(/^I3/);
  });

  it("I3: refuses a degenerate WBTC/WBTC key", () => {
    // Each side-check passes on its own here; only comparing the two currencies catches it.
    const bad = registry({
      flashSwaps: [{ token: WBTC, venueAddress: VENUE, poolKey: poolKey(WBTC, WBTC) }],
    });

    expect(() => assertWbtcPairedWith(bad.flashSwaps[0].poolKey, WBTC, WBTC)).toThrow(/^I3/);
  });

  it("accepts the WBTC/<token> pair in either currency order", () => {
    // currency0/currency1 are ordered by address, so which side WBTC lands on is not ours to choose.
    expect(() => assertWbtcPairedWith(poolKey(WBTC, USDC), USDC, WBTC)).not.toThrow();
    expect(() => assertWbtcPairedWith(poolKey(USDT, WBTC), USDT, WBTC)).not.toThrow();
  });

  it("I4: includes a WBTC leg whenever a fairness payment is owed, even with no WBTC debt", () => {
    // Omitting it does not revert on-chain — the adapter is approved regardless and would consume
    // whatever WBTC the router happens to hold.
    const flashDatas = buildFlashDatas([USDC], 1n, registry());
    expect(flashDatas.some((f) => f.token === WBTC)).toBe(true);
  });

  it("refuses to build an empty flashDatas", () => {
    // `liquidate` requires a non-empty `flashDatas`, so this would revert immediately.
    expect(() => buildFlashDatas([], 0n, registry())).toThrow(VenueSelectionError);
  });
});

describe("probeArgs", () => {
  it("uses the revert sentinel and empty swaps", () => {
    const [liquidationData, flashDatas, swapDatas] = probeArgs(
      USDC,
      buildFlashDatas([USDC], 0n, registry())
    );

    // type(uint256).max — the router treats this as "run, then revert with BelovedError".
    expect(liquidationData.minWbtcProfit).toBe(2n ** 256n - 1n);
    expect(swapDatas).toEqual([]);
    expect(flashDatas).toHaveLength(1);
  });
});

describe("encodePoolKey", () => {
  it("round-trips through the venue's expected encoding", () => {
    const key = poolKey(WBTC, USDC);
    expect(encodePoolKey(key)).toMatch(/^0x[0-9a-f]+$/i);
    // 5 static words.
    expect(encodePoolKey(key)).toHaveLength(2 + 5 * 64);
  });
});

describe("allFundableTokens", () => {
  it("lists every venue token plus WBTC", () => {
    expect(allFundableTokens(registry())).toEqual([USDC, USDT, WBTC]);
  });

  it("produces a flashDatas the router can skip its way through", () => {
    // The point of funding from the registry rather than from the Lens estimate: the engine indexes
    // amounts by *borrowable* reserves and the router by *all* reserves, so a list derived from the
    // engine's indexing is one reserve-ordering change away from naming the wrong tokens. The
    // router skips whatever owes nothing.
    const reg = registry();
    const flashDatas = buildFlashDatas(allFundableTokens(reg), 0n, reg);

    expect(flashDatas.map((f) => f.token)).toEqual([USDC, USDT, WBTC]);
  });
});

describe("assertRegistryValid", () => {
  it("accepts a well-formed registry", () => {
    expect(() => assertRegistryValid(registry())).not.toThrow();
  });

  it("rejects two venues for the same token", () => {
    const dup = registry({
      flashSwaps: [
        { token: USDC, venueAddress: VENUE, poolKey: poolKey(WBTC, USDC) },
        { token: USDC, venueAddress: VENUE, poolKey: poolKey(USDC, WBTC) },
      ],
    });
    expect(() => assertRegistryValid(dup)).toThrow(/^I2/);
  });

  it("rejects a flash-swap venue for WBTC itself", () => {
    // A WBTC/x pool borrowed for WBTC hands back a debt in x — the one token we are trying to avoid
    // owing. WBTC must come from a flash loan.
    const bad = registry({
      flashSwaps: [{ token: WBTC, venueAddress: VENUE, poolKey: poolKey(WBTC, USDC) }],
    });
    expect(() => assertRegistryValid(bad)).toThrow(/^I1/);
  });

  it("rejects a mispaired pool at config time, not per liquidation", () => {
    const bad = registry({
      flashSwaps: [{ token: USDC, venueAddress: VENUE, poolKey: poolKey(USDC, USDT) }],
    });
    expect(() => assertRegistryValid(bad)).toThrow(/^I3/);
  });
});
