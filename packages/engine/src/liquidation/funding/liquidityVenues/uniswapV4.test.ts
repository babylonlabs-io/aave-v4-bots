import { VenueType, encodePoolKey, poolIdOf, v4QuoterAbi } from "@repo/abis";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  encodeErrorResult,
  getAddress,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { type ReadCache, createReadCache } from "../venueRoutes/cache";
import { SWAP_VENUE, USDC, USDT, WBTC, poolKey } from "../venueRoutes/testKit";
import type { SourceDeps } from "../venueRoutes/types";
import {
  assertSharedPoolManager,
  createUniswapV4Source,
  flashSwapCostBps,
  isNotEnoughLiquidity,
} from "./uniswapV4";

const QUOTER = "0x7777777777777777777777777777777777777777" as Address;
const STATE_VIEW = "0x8888888888888888888888888888888888888888" as Address;
const POOL_MANAGER = "0x9999999999999999999999999999999999999999" as Address;
const OTHER_MANAGER = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

const Q96 = 1n << 96n;
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** A revert as viem surfaces it: genuinely ABI-encoded, then decoded against the quoter's ABI. */
const quoterRevert = (data: Hex) =>
  new BaseError("execution reverted", {
    cause: new ContractFunctionRevertedError({
      abi: v4QuoterAbi as unknown as never,
      data,
      functionName: "quoteExactOutputSingle",
    }),
  });
const wrapped = (inner: Hex) =>
  encodeErrorResult({ abi: v4QuoterAbi, errorName: "UnexpectedRevertBytes", args: [inner] });
const notEnoughLiquidity = (poolId: Hex) =>
  encodeErrorResult({ abi: v4QuoterAbi, errorName: "NotEnoughLiquidity", args: [poolId] });

function setup(
  over: { amountIn?: bigint; revert?: unknown; sqrtPriceX96?: bigint; key?: typeof usdcKey } = {}
) {
  const publicClient = {
    simulateContract: vi.fn(async () => {
      if (over.revert !== undefined) throw over.revert;
      return { result: [over.amountIn ?? 1_003n, 120_000n] };
    }),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getSlot0") return [over.sqrtPriceX96 ?? Q96, 0, 0, 3000];
      throw new Error(`unexpected read ${functionName}`);
    }),
  } as unknown as PublicClient;
  let cache: ReadCache = createReadCache();
  const deps: SourceDeps = {
    publicClient,
    wbtc: WBTC,
    cache: () => cache,
    quoter: QUOTER,
    stateView: STATE_VIEW,
  };
  const key = over.key ?? usdcKey;
  const token = key === usdtKey ? USDT : USDC;
  return {
    publicClient,
    deps,
    key,
    source: createUniswapV4Source({ venueAddress: SWAP_VENUE, token, poolKey: key }, 0, deps),
    nextCycle: () => {
      cache = createReadCache();
    },
  };
}

// WBTC is currency0 in one pool and currency1 in the other, so both directions are exercised.
const usdcKey = poolKey(WBTC, USDC);
const usdtKey = poolKey(USDT, WBTC);

const simulateArgs = (client: PublicClient) =>
  vi.mocked(client.simulateContract).mock.calls[0][0] as unknown as {
    address: Address;
    functionName: string;
    args: readonly [{ zeroForOne: boolean; exactAmount: bigint; hookData: Hex; poolKey: unknown }];
  };

describe("createUniswapV4Source", () => {
  it("repays the quoter's exact-output input, priced against the pool's spot", async () => {
    const { source } = setup({ amountIn: 1_003n, sqrtPriceX96: Q96 });

    await expect(source.quote(USDC, 1_000n)).resolves.toEqual({
      available: true,
      repayWbtc: 1_003n,
      costBps: 30n,
    });
  });

  it("quotes zeroForOne when the token is currency1, with empty hook data", async () => {
    const { source, publicClient } = setup({ key: usdcKey });
    await source.quote(USDC, 1_000n);

    const call = simulateArgs(publicClient);
    expect(call.address).toBe(QUOTER);
    expect(call.functionName).toBe("quoteExactOutputSingle");
    expect(call.args[0]).toMatchObject({ zeroForOne: true, exactAmount: 1_000n, hookData: "0x" });
    expect(call.args[0].poolKey).toEqual(usdcKey);
  });

  it("quotes oneForZero when the token is currency0", async () => {
    const { source, publicClient } = setup({ key: usdtKey });
    await source.quote(USDT, 1_000n);

    expect(simulateArgs(publicClient).args[0].zeroForOne).toBe(false);
  });

  it("is unavailable when the quoter wraps NotEnoughLiquidity for this pool", async () => {
    const revert = quoterRevert(wrapped(notEnoughLiquidity(poolIdOf(usdcKey))));
    const { source } = setup({ revert });

    await expect(source.quote(USDC, 1_000n)).resolves.toEqual({
      available: false,
      reason: "NotEnoughLiquidity",
    });
  });

  it("throws on NotEnoughLiquidity naming another pool — it did not price this one", async () => {
    const revert = quoterRevert(wrapped(notEnoughLiquidity(poolIdOf(usdtKey))));
    const { source } = setup({ revert });

    await expect(source.quote(USDC, 1_000n)).rejects.toBe(revert);
  });

  it("throws on any other revert and on an RPC failure", async () => {
    // e.g. PoolNotInitialized, or a hook rejecting the swap: not a verdict about the size.
    const other = quoterRevert(wrapped("0x486aa307"));
    await expect(setup({ revert: other }).source.quote(USDC, 1_000n)).rejects.toBe(other);

    const rpc = new Error("fetch failed");
    await expect(setup({ revert: rpc }).source.quote(USDC, 1_000n)).rejects.toBe(rpc);
  });

  it("refuses a size the quoter's uint128 cannot carry, and accepts the largest that fits", async () => {
    const { source, publicClient } = setup();

    await expect(source.quote(USDC, 1n << 128n)).rejects.toThrow(/uint128/);
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    await expect(source.quote(USDC, (1n << 128n) - 1n)).resolves.toMatchObject({
      available: true,
    });
  });

  it("reads the spot price once per cycle, but quotes every size", async () => {
    const { source, publicClient, nextCycle } = setup();

    await source.quote(USDC, 1_000n);
    await source.quote(USDC, 2_000n);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(publicClient.simulateContract).toHaveBeenCalledTimes(2);

    nextCycle();
    await source.quote(USDC, 1_000n);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it("throws on an uninitialised pool", async () => {
    const { source } = setup({ sqrtPriceX96: 0n });

    await expect(source.quote(USDC, 1_000n)).rejects.toThrow(/not initialized/);
  });

  it("emits a UniswapV4 flash swap carrying the encoded pool key, identified by pool id", () => {
    const { source } = setup();

    expect(source.id).toBe(`univ4:${SWAP_VENUE}:${poolIdOf(usdcKey)}`);
    expect(source.flashData()).toEqual({
      venueType: VenueType.UniswapV4FlashSwap,
      venueAddress: SWAP_VENUE,
      token: USDC,
      swapData: encodePoolKey(usdcKey),
    });
  });

  it("refuses at construction a pool that is not WBTC/<token>, or missing quoter addresses", () => {
    const { deps } = setup();

    expect(() =>
      createUniswapV4Source(
        { venueAddress: SWAP_VENUE, token: USDC, poolKey: poolKey(USDC, USDT) },
        0,
        deps
      )
    ).toThrow(/^I3/);
    expect(() =>
      createUniswapV4Source({ venueAddress: SWAP_VENUE, token: USDC, poolKey: usdcKey }, 0, {
        ...deps,
        quoter: undefined,
      })
    ).toThrow(/quoter/);
  });
});

describe("isNotEnoughLiquidity", () => {
  const poolId = poolIdOf(usdcKey);

  it("accepts the verdict wrapped or bare, and matches the pool id case-insensitively", () => {
    expect(isNotEnoughLiquidity(quoterRevert(wrapped(notEnoughLiquidity(poolId))), poolId)).toBe(
      true
    );
    expect(isNotEnoughLiquidity(quoterRevert(notEnoughLiquidity(poolId)), poolId)).toBe(true);
    expect(
      isNotEnoughLiquidity(
        quoterRevert(wrapped(notEnoughLiquidity(poolId))),
        poolId.toUpperCase() as Hex
      )
    ).toBe(true);
  });

  it("rejects wrapped bytes that do not decode, and errors that are not reverts", () => {
    expect(isNotEnoughLiquidity(quoterRevert(wrapped("0xdeadbeef")), poolId)).toBe(false);
    expect(isNotEnoughLiquidity(new Error("fetch failed"), poolId)).toBe(false);
    expect(isNotEnoughLiquidity("nope", poolId)).toBe(false);
  });
});

describe("flashSwapCostBps", () => {
  it("is the fee over spot at a price of one, in either orientation", () => {
    expect(flashSwapCostBps(1_003n, 1_000n, Q96, true)).toBe(30n);
    expect(flashSwapCostBps(1_003n, 1_000n, Q96, false)).toBe(30n);
  });

  it("values the borrowed side through the price in the right direction", () => {
    // sqrtPrice 2 → price 4 currency1 per currency0.
    // WBTC is currency0: 1_000 of currency1 is worth 250 WBTC.
    expect(flashSwapCostBps(251n, 1_000n, 2n * Q96, true)).toBe(40n);
    // WBTC is currency1: 1_000 of currency0 is worth 4_000 WBTC.
    expect(flashSwapCostBps(4_040n, 1_000n, 2n * Q96, false)).toBe(100n);
  });

  it("rounds the spot value up and truncates the result toward zero, in both signs", () => {
    // Price 9, WBTC currency0: 1_000 / 9 = 111.1 → 112.
    expect(flashSwapCostBps(112n, 1_000n, 3n * Q96, true)).toBe(0n);
    expect(flashSwapCostBps(4n, 3n, Q96, true)).toBe(3_333n);
    expect(flashSwapCostBps(2n, 3n, Q96, true)).toBe(-3_333n);
  });

  it("stays exact at the extremes of the price range", () => {
    // At the lowest price, the borrowed side is worth vastly more WBTC than any real input.
    expect(flashSwapCostBps(1_000n, 1_000n, MIN_SQRT_PRICE, true)).toBe(-9_999n);
    const atMax = flashSwapCostBps(5n, (1n << 128n) - 1n, MAX_SQRT_PRICE, true);
    expect(typeof atMax).toBe("bigint");
    expect(atMax > 0n).toBe(true);
  });

  it("refuses a non-positive price or size", () => {
    expect(() => flashSwapCostBps(1n, 1n, 0n, true)).toThrow(/sqrtPriceX96/);
    expect(() => flashSwapCostBps(1n, 0n, Q96, true)).toThrow(/amountOut/);
  });
});

describe("assertSharedPoolManager", () => {
  const VENUE_B = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const client = (managers: Record<string, Address>) =>
    ({
      readContract: vi.fn(async ({ address }: { address: Address }) => managers[address]),
    }) as unknown as PublicClient;

  it("passes when the quoter, StateView and every venue share a pool manager", async () => {
    const publicClient = client({
      [QUOTER]: POOL_MANAGER,
      [STATE_VIEW]: POOL_MANAGER,
      [SWAP_VENUE]: POOL_MANAGER,
    });

    await expect(
      assertSharedPoolManager([SWAP_VENUE, SWAP_VENUE.toLowerCase() as Address], {
        publicClient,
        quoter: QUOTER,
        stateView: STATE_VIEW,
      })
    ).resolves.toBeUndefined();
    // Two pools on one venue: the venue is read once.
    expect(publicClient.readContract).toHaveBeenCalledTimes(3);
  });

  it("names every deployment on a different pool manager", async () => {
    const publicClient = client({
      [QUOTER]: POOL_MANAGER,
      [STATE_VIEW]: POOL_MANAGER,
      [SWAP_VENUE]: POOL_MANAGER,
      [VENUE_B]: OTHER_MANAGER,
    });

    await expect(
      assertSharedPoolManager([SWAP_VENUE, VENUE_B], {
        publicClient,
        quoter: QUOTER,
        stateView: STATE_VIEW,
      })
    ).rejects.toThrow(new RegExp(`swap venue ${VENUE_B} uses ${OTHER_MANAGER}`));
  });
});
