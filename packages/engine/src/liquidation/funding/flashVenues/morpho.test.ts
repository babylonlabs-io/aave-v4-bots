import { VenueType } from "@repo/abis";
import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type ReadCache, createReadCache } from "../venueRoutes/cache";
import { MORPHO, USDC, WBTC } from "../venueRoutes/testKit";
import type { SourceDeps } from "../venueRoutes/types";
import { createMorphoSource } from "./morpho";

const clientWithBalance = (balance: bigint) =>
  ({ readContract: vi.fn().mockResolvedValue(balance) }) as unknown as PublicClient;

function setup(balance: bigint) {
  const publicClient = clientWithBalance(balance);
  let cache: ReadCache = createReadCache();
  const deps: SourceDeps = { publicClient, wbtc: WBTC, cache: () => cache };
  return {
    publicClient,
    source: createMorphoSource({ morpho: MORPHO }, 0, deps),
    nextCycle: () => {
      cache = createReadCache();
    },
  };
}

describe("createMorphoSource", () => {
  it("repays the principal at zero cost when Morpho holds enough WBTC", async () => {
    const { source, publicClient } = setup(5_000n);

    await expect(source.quote(WBTC, 1_000n)).resolves.toEqual({
      available: true,
      repayWbtc: 1_000n,
      costBps: 0n,
      liquidity: 5_000n,
    });
    expect(vi.mocked(publicClient.readContract).mock.calls[0][0]).toMatchObject({
      address: WBTC,
      functionName: "balanceOf",
      args: [MORPHO],
    });
  });

  it("accepts a size exactly at its balance, and refuses one above it", async () => {
    const { source } = setup(1_000n);

    await expect(source.quote(WBTC, 1_000n)).resolves.toMatchObject({ available: true });
    await expect(source.quote(WBTC, 1_001n)).resolves.toMatchObject({
      available: false,
      liquidity: 1_000n,
    });
  });

  it("reads its balance once per cycle, whatever the amounts, and again next cycle", async () => {
    const { source, publicClient, nextCycle } = setup(5_000n);

    await source.quote(WBTC, 1_000n);
    await source.quote(WBTC, 2_000n);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);

    nextCycle();
    await source.quote(WBTC, 1_000n);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it("throws on another asset or a non-positive size rather than answering", async () => {
    const { source } = setup(5_000n);

    await expect(source.quote(USDC, 1_000n)).rejects.toThrow(/lends/);
    await expect(source.quote(WBTC, 0n)).rejects.toThrow(/must be positive/);
  });

  it("emits a Morpho WBTC flash loan with a checksummed id", () => {
    const { source } = setup(0n);

    expect(source.id).toBe(`morpho:${MORPHO}`);
    expect(source.flashData()).toEqual({
      venueType: VenueType.Morpho,
      venueAddress: MORPHO,
      token: WBTC,
      swapData: "0x",
    });
  });

  it("checksums the configured addresses", () => {
    const source = createMorphoSource({ morpho: MORPHO.toLowerCase() as Address }, 0, {
      publicClient: clientWithBalance(0n),
      wbtc: WBTC.toLowerCase() as Address,
      cache: createReadCache,
    });

    expect(source.token).toBe(WBTC);
    expect(source.flashData().venueAddress).toBe(MORPHO);
  });
});
