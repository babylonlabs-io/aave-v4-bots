import { VenueType } from "@repo/abis";
import { type Address, type PublicClient, zeroAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type ReadCache, createReadCache } from "../venueRoutes/cache";
import { AAVE_POOL, USDC, WBTC } from "../venueRoutes/testKit";
import type { SourceDeps } from "../venueRoutes/types";
import { assertWbtcListed, createAaveV3Source, percentMulCeil } from "./aaveV3";

const A_TOKEN = "0x6666666666666666666666666666666666666666" as Address;

function setup(state: {
  premium: bigint;
  virtualBalance?: bigint;
  aTokenSupply?: bigint;
  aToken?: Address;
}) {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "FLASHLOAN_PREMIUM_TOTAL":
          return state.premium;
        case "getVirtualUnderlyingBalance":
          return state.virtualBalance ?? 10_000_000n;
        case "getReserveData":
          return { aTokenAddress: state.aToken ?? A_TOKEN };
        case "totalSupply":
          return state.aTokenSupply ?? 20_000_000n;
      }
      throw new Error(`unexpected read ${functionName}`);
    }),
  } as unknown as PublicClient;
  let cache: ReadCache = createReadCache();
  const deps: SourceDeps = { publicClient, wbtc: WBTC, cache: () => cache };
  return {
    publicClient,
    deps,
    source: createAaveV3Source({ pool: AAVE_POOL }, 0, deps),
    nextCycle: () => {
      cache = createReadCache();
    },
  };
}

const callsTo = (client: PublicClient, functionName: string) =>
  vi
    .mocked(client.readContract)
    .mock.calls.filter(
      ([args]) => (args as { functionName: string }).functionName === functionName
    );

describe("percentMulCeil", () => {
  it("rounds any remainder up, as Aave's PercentageMath does", () => {
    expect(percentMulCeil(1_000n, 5n)).toBe(1n); // 0.5 → 1
    expect(percentMulCeil(999n, 5n)).toBe(1n); // 0.4995 → 1
    expect(percentMulCeil(1n, 5n)).toBe(1n); // 0.0005 → 1
    expect(percentMulCeil(2_000_000n, 9n)).toBe(1_800n); // exact
    expect(percentMulCeil(0n, 5n)).toBe(0n);
  });
});

describe("createAaveV3Source", () => {
  it("repays principal plus the premium rounded up, and reports the premium as its cost", async () => {
    // Rounding half up would quote 999 + 0 here; the pool charges 1.
    const { source } = setup({ premium: 5n });

    await expect(source.quote(WBTC, 999n)).resolves.toEqual({
      available: true,
      repayWbtc: 1_000n,
      costBps: 5n,
      liquidity: 10_000_000n,
    });
  });

  it("reads the virtual balance from the pool and the total supply from its aToken", async () => {
    const { source, publicClient } = setup({ premium: 5n });
    await source.quote(WBTC, 1_000n);

    expect(callsTo(publicClient, "getVirtualUnderlyingBalance")[0][0]).toMatchObject({
      address: AAVE_POOL,
      args: [WBTC],
    });
    expect(callsTo(publicClient, "totalSupply")[0][0]).toMatchObject({ address: A_TOKEN });
    // The aToken's WBTC balance overstates what can be lent, so nothing reads it.
    expect(callsTo(publicClient, "balanceOf")).toHaveLength(0);
  });

  it("is bounded by the virtual balance when that is the lower figure", async () => {
    const { source } = setup({ premium: 5n, virtualBalance: 1_000n, aTokenSupply: 5_000n });

    await expect(source.quote(WBTC, 1_000n)).resolves.toMatchObject({
      available: true,
      liquidity: 1_000n,
    });
    await expect(source.quote(WBTC, 1_001n)).resolves.toMatchObject({
      available: false,
      liquidity: 1_000n,
    });
  });

  it("is bounded by the aToken's total supply when that is the lower figure", async () => {
    const { source } = setup({ premium: 5n, virtualBalance: 5_000n, aTokenSupply: 1_000n });

    await expect(source.quote(WBTC, 1_000n)).resolves.toMatchObject({
      available: true,
      liquidity: 1_000n,
    });
    await expect(source.quote(WBTC, 1_001n)).resolves.toMatchObject({
      available: false,
      liquidity: 1_000n,
    });
  });

  it("reads each figure once per cycle and again the next, so a governance change is priced", async () => {
    const state = { premium: 5n };
    const { source, publicClient, nextCycle } = setup(state);

    await expect(source.quote(WBTC, 2_000_000n)).resolves.toMatchObject({ repayWbtc: 2_001_000n });
    state.premium = 9n;
    // Same cycle: still the figures read at its start.
    await expect(source.quote(WBTC, 1_000_000n)).resolves.toMatchObject({ repayWbtc: 1_000_500n });
    for (const read of ["FLASHLOAN_PREMIUM_TOTAL", "getVirtualUnderlyingBalance", "totalSupply"]) {
      expect(callsTo(publicClient, read), read).toHaveLength(1);
    }

    nextCycle();
    await expect(source.quote(WBTC, 2_000_000n)).resolves.toMatchObject({ repayWbtc: 2_001_800n });
  });

  it("throws on another asset", async () => {
    const { source } = setup({ premium: 5n });

    await expect(source.quote(USDC, 1_000n)).rejects.toThrow(/lends/);
  });

  it("emits an Aave v3 WBTC flash loan", () => {
    const { source } = setup({ premium: 5n });

    expect(source.id).toBe(`aavev3:${AAVE_POOL}`);
    expect(source.flashData()).toEqual({
      venueType: VenueType.AaveV3,
      venueAddress: AAVE_POOL,
      token: WBTC,
      swapData: "0x",
    });
  });
});

describe("assertWbtcListed", () => {
  it("passes when WBTC has an aToken, reading each distinct pool once", async () => {
    const { deps, publicClient } = setup({ premium: 5n });

    await expect(
      assertWbtcListed([AAVE_POOL, AAVE_POOL.toLowerCase() as Address], deps)
    ).resolves.toBeUndefined();
    expect(callsTo(publicClient, "getReserveData")).toHaveLength(1);
  });

  it("names a pool that does not list WBTC — a configuration error caught at boot", async () => {
    // Unlisted, the virtual balance reads zero and the venue would silently never fund anything.
    const { deps } = setup({ premium: 5n, aToken: zeroAddress });

    await expect(assertWbtcListed([AAVE_POOL], deps)).rejects.toThrow(
      new RegExp(`not listed on Aave v3 pool ${AAVE_POOL}`)
    );
  });
});
