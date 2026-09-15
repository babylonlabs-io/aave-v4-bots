import { encodePoolKey, liquidationRouterAbi, poolIdOf, v4QuoterAbi } from "@repo/abis";
import { createRiskGate } from "@repo/risk";
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
import type { SpokeReserves } from "../reserves";
import { FlashFunding, type FlashFundingDeps } from "./flash";
import type { LiquidationCandidate } from "./types";
import { parseFlashVenues } from "./venueRoutes/factory";
import { MORPHO, SWAP_VENUE, USDC, USDT, WBTC, poolKey } from "./venueRoutes/testKit";
import { type VenueRegistry, allFundableTokens, buildFlashDatas } from "./venues";

// `FlashFunding.vet` on its own, so the ranked route can be driven venue by venue. The engine-level
// flash tests cover the fixed route end to end.

const ROUTER = "0x9999999999999999999999999999999999999999" as Address;
const OWNER = "0x5555555555555555555555555555555555555555" as Address;
const QUOTER = "0x7777777777777777777777777777777777777777" as Address;
const STATE_VIEW = "0x8888888888888888888888888888888888888888" as Address;
const POOL_MANAGER = "0x4444444444444444444444444444444444444444" as Address;
const SPOKE = "0x3333333333333333333333333333333333333333" as Address;
const Q96 = 1n << 96n;

const usdc3000 = poolKey(WBTC, USDC, 3000);
const usdc500 = poolKey(WBTC, USDC, 500);
const usdt3000 = poolKey(WBTC, USDT, 3000);

const pool = (token: Address, fee: number) =>
  `univ4:${SWAP_VENUE}:${token}:${WBTC}:${token}:${fee}:60`;
const ENTRIES = [`morpho:${MORPHO}`, pool(USDC, 3000), pool(USDC, 500), pool(USDT, 3000)].join(",");

const TOPOLOGY: SpokeReserves = {
  spoke: SPOKE,
  reserves: [
    { id: 0, token: USDC, borrowable: true },
    { id: 1, token: WBTC, borrowable: true },
    { id: 2, token: USDT, borrowable: true },
  ],
};

const candidate = (proxy: string, over: Partial<LiquidationCandidate> = {}) =>
  ({
    position: { borrower: OWNER, proxyAddress: proxy },
    debtReserveIds: [0n],
    debtToCoverAmounts: [1_000n],
    vaultId: `0x${"0".repeat(64)}`,
    wbtcPayment: 50n,
    ...over,
  }) as LiquidationCandidate;

const PROXY_A = "0x000000000000000000000000000000000000000A";
const PROXY_B = "0x000000000000000000000000000000000000000B";

const revert = (abi: unknown, data: Hex, functionName: string) =>
  new BaseError("execution reverted", {
    cause: new ContractFunctionRevertedError({ abi: abi as never, data, functionName }),
  });

type QuoteAnswer = bigint | "notEnoughLiquidity" | "rpcDown";

function setup(
  over: {
    ranking?: boolean;
    entries?: string;
    topology?: SpokeReserves;
    reservesError?: boolean;
    /** The quoter's answer per pool fee. Unlisted fees quote 1% over the size. */
    quotes?: Record<number, QuoteAnswer>;
    net?: bigint;
    debts?: readonly { venue: Address; amount: bigint }[];
    poolManagers?: Record<string, Address>;
  } = {}
) {
  const publicClient = {
    readContract: vi.fn(
      async ({
        functionName,
        address,
        args,
      }: { functionName: string; address: Address; args?: readonly unknown[] }) => {
        switch (functionName) {
          case "balanceOf":
            // Morpho lends from its balance; the router starts every cycle empty.
            return getAddress(args?.[0] as Address) === MORPHO ? 10n ** 12n : 0n;
          case "getSlot0":
            return [Q96, 0, 0, 3000];
          case "poolManager":
          case "uniV4PoolManager":
            return over.poolManagers?.[getAddress(address)] ?? POOL_MANAGER;
        }
        throw new Error(`unexpected read ${functionName}`);
      }
    ),
    simulateContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === "quoteExactOutputSingle") {
          const { poolKey: key, exactAmount } = args[0] as {
            poolKey: typeof usdc3000;
            exactAmount: bigint;
          };
          const answer = over.quotes?.[key.fee] ?? exactAmount + exactAmount / 100n;
          if (answer === "rpcDown") throw new Error("fetch failed");
          if (answer === "notEnoughLiquidity") {
            const inner = encodeErrorResult({
              abi: v4QuoterAbi,
              errorName: "NotEnoughLiquidity",
              args: [poolIdOf(key)],
            });
            throw revert(
              v4QuoterAbi,
              encodeErrorResult({
                abi: v4QuoterAbi,
                errorName: "UnexpectedRevertBytes",
                args: [inner],
              }),
              functionName
            );
          }
          return { result: [answer, 0n] };
        }
        if (functionName === "liquidate") {
          const debts = (over.debts ?? []).map((d) => ({ token: WBTC, ...d }));
          throw revert(
            liquidationRouterAbi,
            encodeErrorResult({
              abi: liquidationRouterAbi,
              errorName: "BelovedError",
              args: [over.net ?? 100_000n, debts],
            }),
            functionName
          );
        }
        throw new Error(`unexpected simulation ${functionName}`);
      }
    ),
  } as unknown as PublicClient;

  const metrics = { recordError: vi.fn(), recordSimulationFailed: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reserves = vi.fn(async () => {
    if (over.reservesError) throw new Error("connect ECONNREFUSED");
    return over.topology ?? TOPOLOGY;
  });

  const registry: VenueRegistry = {
    wbtc: WBTC,
    flashSwaps: [{ token: USDC, venueAddress: SWAP_VENUE, poolKey: usdc3000 }],
    wbtcFlashLoan: { venueType: 1, venueAddress: MORPHO },
  };

  const common = {
    publicClient,
    wbtcAddress: WBTC,
    executor: { identity: { from: OWNER, chainId: 1 } } as unknown as FlashFundingDeps["executor"],
    logger: logger as unknown as FlashFundingDeps["logger"],
    metrics,
    risk: createRiskGate(),
    reserves,
    routerAddress: ROUTER,
    maxSlippageBps: 2_000,
  };
  const deps: FlashFundingDeps =
    over.ranking === false
      ? { ...common, venues: registry }
      : {
          ...common,
          ranking: {
            entries: parseFlashVenues(over.entries ?? ENTRIES),
            quoter: QUOTER,
            stateView: STATE_VIEW,
          },
        };

  const calls = (functionName: string) =>
    vi
      .mocked(publicClient.simulateContract)
      .mock.calls.map(
        ([call]) => call as unknown as { functionName: string; args: readonly unknown[] }
      )
      .filter((call) => call.functionName === functionName);

  return {
    funding: new FlashFunding(deps),
    publicClient,
    metrics,
    logger,
    reserves,
    registry,
    probes: () =>
      calls("liquidate").map(
        (c) => c.args[1] as readonly { token: Address; venueAddress: Address; swapData: Hex }[]
      ),
    quotes: () => calls("quoteExactOutputSingle"),
  };
}

describe("FlashFunding with fixed venues", () => {
  it("quotes nothing and probes the fixed route", async () => {
    const { funding, registry, probes, quotes, reserves } = setup({ ranking: false });

    await funding.vet([candidate(PROXY_A)]);

    expect(quotes()).toHaveLength(0);
    expect(reserves).not.toHaveBeenCalled();
    expect(probes()).toEqual([buildFlashDatas(allFundableTokens(registry), 50n, registry)]);
  });
});

describe("FlashFunding with venue ranking", () => {
  it("routes each owed token through its cheapest pool, and leaves the rest on their first", async () => {
    const { funding, probes } = setup({
      quotes: { 3000: 1_020n, 500: 1_005n },
      net: 100_000n,
      debts: [
        { venue: SWAP_VENUE, amount: 1_005n },
        { venue: MORPHO, amount: 50n },
      ],
    });

    const [funded] = await funding.vet([candidate(PROXY_A)]);

    const [route] = probes();
    expect(route.map((f) => f.token)).toEqual([USDC, USDT, WBTC]);
    expect(route[0].swapData).toBe(encodePoolKey(usdc500));
    // USDT is owed nothing: its only pool rides along, and the router skips it.
    expect(route[1].swapData).toBe(encodePoolKey(usdt3000));
    expect(route[2].venueAddress).toBe(MORPHO);
    // The probe, not the quote, prices the action and derives the on-chain floor.
    expect(funded.risk.expectedProfit).toBe(100_000n - 1_055n);
    expect(funded.call.args?.[1]).toEqual(route);
  });

  it("quotes a token's only venue too, and only the tokens the candidate owes", async () => {
    const { funding, publicClient, quotes } = setup();

    await funding.vet([candidate(PROXY_A)]);

    // Morpho is WBTC's only source, and still quoted: its balance is read.
    const morphoReads = vi
      .mocked(publicClient.readContract)
      .mock.calls.filter(([call]) => (call as { args?: readonly unknown[] }).args?.[0] === MORPHO);
    expect(morphoReads).toHaveLength(1);
    // The two USDC pools, never the USDT one.
    expect(quotes()).toHaveLength(2);
  });

  it("routes through the first configured pool, and says so, when no quote comes back", async () => {
    const { funding, probes, metrics } = setup({ quotes: { 3000: "rpcDown", 500: "rpcDown" } });

    await funding.vet([candidate(PROXY_A)]);

    expect(metrics.recordError).toHaveBeenCalledWith("venue_quote_degraded");
    expect(probes()[0][0].swapData).toBe(encodePoolKey(usdc3000));
  });

  it("skips a candidate no venue can fill, before probing it", async () => {
    const { funding, probes, metrics, logger } = setup({
      quotes: { 3000: "notEnoughLiquidity", 500: "notEnoughLiquidity" },
    });

    await expect(funding.vet([candidate(PROXY_A)])).resolves.toEqual([]);

    expect(probes()).toHaveLength(0);
    expect(metrics.recordSimulationFailed).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no venue can fund it/));
  });

  it("skips a candidate owing a shared token on the later reserve, before quoting it", async () => {
    const { funding, probes, quotes } = setup({
      topology: {
        spoke: SPOKE,
        reserves: [...TOPOLOGY.reserves, { id: 3, token: USDC, borrowable: true }],
      },
    });

    await expect(funding.vet([candidate(PROXY_A, { debtReserveIds: [3n] })])).resolves.toEqual([]);

    expect(quotes()).toHaveLength(0);
    expect(probes()).toHaveLength(0);
  });

  it("funds a candidate owing a shared token only on the first reserve", async () => {
    const { funding, probes } = setup({
      topology: {
        spoke: SPOKE,
        reserves: [...TOPOLOGY.reserves, { id: 3, token: USDC, borrowable: true }],
      },
    });

    await expect(funding.vet([candidate(PROXY_A)])).resolves.toHaveLength(1);

    expect(probes()).toHaveLength(1);
  });

  it("flags a venue the probe owes more than its quote, and still funds the candidate", async () => {
    const { funding, metrics } = setup({
      quotes: { 3000: 1_020n, 500: 1_005n },
      debts: [
        { venue: SWAP_VENUE, amount: 1_100n },
        { venue: MORPHO, amount: 50n },
      ],
    });

    await expect(funding.vet([candidate(PROXY_A)])).resolves.toHaveLength(1);

    expect(metrics.recordError).toHaveBeenCalledWith("venue_quote_divergence");
    expect(metrics.recordError).toHaveBeenCalledTimes(1);
  });

  it("shares a quote between candidates of one cycle, and quotes again the next", async () => {
    const { funding, quotes } = setup();

    await funding.vet([candidate(PROXY_A), candidate(PROXY_B)]);
    expect(quotes()).toHaveLength(2);

    await funding.vet([candidate(PROXY_A)]);
    expect(quotes()).toHaveLength(4);
  });

  it("reads the reserve list once per cycle, and fails the cycle when it cannot", async () => {
    const ok = setup();
    await ok.funding.vet([candidate(PROXY_A), candidate(PROXY_B)]);
    expect(ok.reserves).toHaveBeenCalledTimes(1);

    const failing = setup({ reservesError: true });
    await expect(failing.funding.vet([candidate(PROXY_A)])).rejects.toThrow(/ECONNREFUSED/);
  });

  it("refuses at construction a malformed entry, naming it", () => {
    expect(() => setup({ entries: `morpho:${MORPHO},univ4:${SWAP_VENUE}` })).toThrow(
      /FLASH_VENUES entry "univ4:0x1111111111111111111111111111111111111111"/
    );
  });

  it("checks at prepare that the quoter and every swap venue share a pool manager", async () => {
    await expect(setup().funding.prepare()).resolves.toBeUndefined();

    const { funding } = setup({
      poolManagers: { [SWAP_VENUE]: "0x6666666666666666666666666666666666666666" },
    });
    await expect(funding.prepare()).rejects.toThrow(/swap venue/);
  });
});
