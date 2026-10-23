import { liquidationRouterAbi } from "@repo/abis";
import { createRiskGate } from "@repo/risk";
import { type Address, BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VenueType } from "@repo/abis";
import { FlashFunding } from "./flash";
import type { LiquidationCandidate } from "./types";
import { buildFlashDatas } from "./venues";

vi.mock("./venues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./venues")>();
  return { ...actual, buildFlashDatas: vi.fn(actual.buildFlashDatas) };
});

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const VENUE = "0x1111111111111111111111111111111111111111" as Address;
const MORPHO = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x9999999999999999999999999999999999999999" as Address;

const venues = {
  wbtc: WBTC,
  flashSwaps: [
    {
      token: USDC,
      venueAddress: VENUE,
      poolKey: {
        currency0: WBTC,
        currency1: USDC,
        fee: 3000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000" as Address,
      },
    },
  ],
  wbtcFlashLoan: { venueType: VenueType.Morpho, venueAddress: MORPHO } as const,
};

const beloved = () =>
  new BaseError("execution reverted", {
    cause: new ContractFunctionRevertedError({
      abi: liquidationRouterAbi as unknown as never,
      data: encodeErrorResult({
        abi: liquidationRouterAbi,
        errorName: "BelovedError",
        args: [1_000_000n, [{ token: WBTC, venue: VENUE, amount: 600_000n }]],
      }),
      functionName: "liquidate",
    }),
  });

describe("FlashFunding fairness payment", () => {
  beforeEach(() => {
    vi.mocked(buildFlashDatas).mockClear();
  });

  it("sizes the venue selection by the fairness payment, not by fee plus fairness", async () => {
    const funding = new FlashFunding({
      publicClient: {
        simulateContract: vi.fn().mockRejectedValue(beloved()),
        readContract: vi.fn(async () => 0n),
      },
      wbtcAddress: WBTC,
      executor: { identity: { from: ROUTER, chainId: 31337 } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metrics: { recordError: vi.fn(), recordSimulationFailed: vi.fn() },
      risk: createRiskGate(),
      routerAddress: ROUTER,
      venues,
      maxSlippageBps: 2_000,
    } as unknown as ConstructorParameters<typeof FlashFunding>[0]);

    const candidate = {
      position: { borrower: "0xb0b", proxyAddress: "0xp" },
      debtReserveId: 0n,
      debtToCover: 100n,
      wbtcPayment: 30n,
      fairnessPayment: 0n,
      vaultId: `0x${"11".repeat(32)}`,
    } as unknown as LiquidationCandidate;

    const [funded] = await funding.vet([candidate]);

    expect(funded).toBeDefined();
    expect(vi.mocked(buildFlashDatas).mock.calls[0][1]).toBe(0n);
  });
});
