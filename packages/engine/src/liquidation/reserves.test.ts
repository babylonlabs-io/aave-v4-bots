import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { MAX_SPOKE_RESERVES, borrowableTokens, discoverSpokeReserves } from "./reserves";

const ADAPTER = "0xadapter" as Address;
const SPOKE = "0xspoke" as Address;
const BORROWABLE = 0x04;
const COLLATERAL_ONLY = 0x00;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A Spoke listing `reserves` in id order. */
const client = (reserves: { flags: number; underlying: string }[], count?: bigint) =>
  ({
    readContract: vi.fn(
      ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "BTC_VAULT_CORE_SPOKE") return Promise.resolve(SPOKE);
        if (functionName === "getReserveCount")
          return Promise.resolve(count ?? BigInt(reserves.length));
        if (functionName === "getReserve")
          return Promise.resolve(reserves[Number(args?.[0] ?? 0n)]);
        return Promise.resolve(0n);
      }
    ),
  }) as unknown as PublicClient;

const discover = (publicClient: PublicClient) =>
  discoverSpokeReserves({
    publicClient,
    adapterAddress: ADAPTER,
    logger,
    tokenSymbol: async () => "TKN",
  });

describe("discoverSpokeReserves", () => {
  // The property the whole fix rests on: index i is reserve id i, whatever the flags say. A
  // borrowable-only list cannot carry this, because it closes the gap the skipped reserve leaves.
  it("returns every reserve at its own id, borrowable or not", async () => {
    const topology = await discover(
      client([
        { flags: COLLATERAL_ONLY, underlying: "0xvaultbtc" },
        { flags: BORROWABLE, underlying: "0xusdc" },
        { flags: BORROWABLE, underlying: "0xusdt" },
      ])
    );

    expect(topology.spoke).toBe(SPOKE);
    expect(topology.reserves).toEqual([
      { id: 0, token: "0xvaultbtc", borrowable: false },
      { id: 1, token: "0xusdc", borrowable: true },
      { id: 2, token: "0xusdt", borrowable: true },
    ]);
  });

  it("has no reserves to report on an empty Spoke", async () => {
    expect((await discover(client([]))).reserves).toEqual([]);
  });

  // The reason the list is read every cycle rather than cached: `updateReserveConfig` flips this
  // without the count moving, and a stale `false` means the token is never approved or published,
  // so every position owing it is blocked until somebody restarts the bot.
  it("reports a flag flip that leaves the reserve count unchanged", async () => {
    const reserves = [{ flags: COLLATERAL_ONLY, underlying: "0xusdt" }];
    const publicClient = client(reserves);

    expect((await discover(publicClient)).reserves[0].borrowable).toBe(false);
    reserves[0].flags = BORROWABLE;
    expect((await discover(publicClient)).reserves[0].borrowable).toBe(true);
  });

  it("sees a reserve appended after the first read", async () => {
    const reserves = [{ flags: BORROWABLE, underlying: "0xusdc" }];
    const publicClient = client(reserves);

    expect((await discover(publicClient)).reserves).toHaveLength(1);
    reserves.push({ flags: BORROWABLE, underlying: "0xusdt" });
    expect((await discover(publicClient)).reserves).toEqual([
      { id: 0, token: "0xusdc", borrowable: true },
      { id: 1, token: "0xusdt", borrowable: true },
    ]);
  });

  // It runs every cycle, so the reserve list is logged when it is first read and when it changes —
  // never on the cycles in between.
  it("logs the list only when it differs from the last read", async () => {
    const publicClient = client([{ flags: BORROWABLE, underlying: "0xusdc" }]);
    const first = await discover(publicClient);
    logger.info.mockClear();

    await discoverSpokeReserves({
      publicClient,
      adapterAddress: ADAPTER,
      logger,
      tokenSymbol: async () => "TKN",
      previous: first,
    });

    expect(logger.info).not.toHaveBeenCalled();
  });

  // `getReserveCount` is a number read from an operator-configured address, and everything after it
  // is a loop. A wrong address can answer with any 256-bit value, which is not a slow boot but a
  // process that allocates until it dies without logging anything anyone can act on.
  it("refuses a reserve count no real deployment has", async () => {
    await expect(discover(client([], MAX_SPOKE_RESERVES + 1n))).rejects.toThrow(
      /past the 256 this bot will enumerate/
    );
  });
});

describe("borrowableTokens", () => {
  it("keeps only what a borrower can still owe", () => {
    const tokens = borrowableTokens({
      spoke: SPOKE,
      reserves: [
        { id: 0, token: "0xvaultbtc" as Address, borrowable: false },
        { id: 1, token: "0xusdc" as Address, borrowable: true },
      ],
    });

    expect(tokens).toEqual(["0xusdc"]);
  });

  // Two reserves can list the same underlying; the balance and allowance behind them are one.
  it("names a token once however many reserves list it", () => {
    const tokens = borrowableTokens({
      spoke: SPOKE,
      reserves: [
        { id: 0, token: "0xUSDC" as Address, borrowable: true },
        { id: 1, token: "0xusdc" as Address, borrowable: true },
      ],
    });

    expect(tokens).toEqual(["0xUSDC"]);
  });
});
