import { type FlashData, liquidationRouterAbi } from "@repo/abis";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  encodeErrorResult,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { ProbeError, minWbtcProfitFloor, probeLiquidation, quoteProfit } from "./flashProbe";

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ROUTER = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const BORROWER = "0x3333333333333333333333333333333333333333" as Address;
const VENUE = "0x4444444444444444444444444444444444444444" as Address;

const FLASH_DATAS: FlashData[] = [
  { venueType: 2, venueAddress: VENUE, token: USDC, swapData: "0x" },
];

/**
 * A rejecting client whose revert data is genuinely ABI-encoded, then decoded back by viem exactly
 * as it would be on-chain. Hand-shaping `revert.data` would let the test pass against an encoding
 * the real contract never produces.
 */
function clientRevertingWith(data: `0x${string}`): PublicClient {
  const revert = new ContractFunctionRevertedError({
    abi: liquidationRouterAbi as unknown as never,
    data,
    functionName: "liquidate",
  });
  const outer = new BaseError("execution reverted", { cause: revert });
  return {
    simulateContract: vi.fn().mockRejectedValue(outer),
  } as unknown as PublicClient;
}

const belovedData = (
  net: bigint,
  debts: readonly { token: Address; venue: Address; amount: bigint }[]
) =>
  encodeErrorResult({
    abi: liquidationRouterAbi,
    errorName: "BelovedError",
    args: [net, debts],
  });

const probe = (publicClient: PublicClient) =>
  probeLiquidation({
    publicClient,
    router: ROUTER,
    owner: OWNER,
    borrower: BORROWER,
    flashDatas: FLASH_DATAS,
  });

describe("probeLiquidation", () => {
  it("decodes BelovedError into the realised WBTC and the venue debts", async () => {
    const client = clientRevertingWith(
      belovedData(1_000_000n, [{ token: WBTC, venue: VENUE, amount: 400_000n }])
    );

    const result = await probe(client);

    expect(result).toEqual({
      kind: "quote",
      netWbtcBeforePayment: 1_000_000n,
      debts: [{ token: WBTC, venue: VENUE, amount: 400_000n }],
    });
  });

  it("sends the revert sentinel and empty swaps, from the owner", async () => {
    const client = clientRevertingWith(belovedData(1n, []));
    await probe(client);

    const call = vi.mocked(client.simulateContract).mock.calls[0][0] as unknown as {
      args: readonly [{ minWbtcProfit: bigint }, unknown, unknown[]];
      account: Address;
    };
    expect(call.args[0].minWbtcProfit).toBe(2n ** 256n - 1n);
    expect(call.args[2]).toEqual([]);
    expect(call.account).toBe(OWNER); // `liquidate` is auth-gated; any other caller reverts early
  });

  it("reports a different revert as unavailable, not as an error", async () => {
    // A position someone else already took, a dry venue, a bad pool key — all "not this candidate,
    // not now", which the engine should skip rather than treat as a malfunction. The router's ABI
    // names only `BelovedError`, so any other selector arrives undecodable.
    const result = await probe(clientRevertingWith("0xdeadbeef"));

    expect(result.kind).toBe("unavailable");
  });

  it("throws when there is no contract revert at all", async () => {
    // An RPC outage must not read as "nothing is liquidatable".
    const client = {
      simulateContract: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as PublicClient;

    await expect(probe(client)).rejects.toBeInstanceOf(ProbeError);
  });

  it("throws when the probe does not revert", async () => {
    // MIN_PROFIT_REVERT_TAG makes the revert unconditional, so success means we are not talking to
    // the contract we think we are.
    const client = {
      simulateContract: vi.fn().mockResolvedValue({ result: 0n }),
    } as unknown as PublicClient;

    await expect(probe(client)).rejects.toThrow(/expected BelovedError/);
  });
});

describe("quoteProfit", () => {
  const debts = [
    { token: WBTC, venue: VENUE, amount: 300_000n },
    { token: WBTC, venue: VENUE, amount: 200_000n },
  ];

  it("nets the venue debts off the realised WBTC", () => {
    expect(quoteProfit({ netWbtcBeforePayment: 1_000_000n, debts }, WBTC)).toEqual({
      realisedWbtc: 1_000_000n,
      totalVenueDebt: 500_000n,
      expectedProfit: 500_000n,
    });
  });

  it("excludes WBTC the router already held", () => {
    // `netWbtcBeforePayment` is a raw balanceOf, so a donated balance would otherwise be booked as
    // profit the liquidation did not earn.
    const quote = quoteProfit({ netWbtcBeforePayment: 1_000_000n, debts }, WBTC, 250_000n);

    expect(quote.realisedWbtc).toBe(750_000n);
    expect(quote.expectedProfit).toBe(250_000n);
  });

  it("reports a loss rather than clamping to zero", () => {
    const quote = quoteProfit({ netWbtcBeforePayment: 400_000n, debts }, WBTC);
    expect(quote.expectedProfit).toBe(-100_000n);
  });

  it("rejects a debt denominated in anything but WBTC", () => {
    // Means the flashDatas broke I1/I3: a flash loan of USDC would need a swap back into USDC, and
    // we send empty swapDatas.
    expect(() =>
      quoteProfit(
        { netWbtcBeforePayment: 1n, debts: [{ token: USDC, venue: VENUE, amount: 1n }] },
        WBTC
      )
    ).toThrow(ProbeError);
  });

  it("compares tokens by checksum, not by string", () => {
    expect(() =>
      quoteProfit(
        {
          netWbtcBeforePayment: 1_000_000n,
          debts: [{ token: WBTC.toLowerCase() as Address, venue: VENUE, amount: 1n }],
        },
        WBTC
      )
    ).not.toThrow();
  });
});

describe("minWbtcProfitFloor", () => {
  it("gives up the configured fraction of the quote", () => {
    expect(minWbtcProfitFloor(1_000_000n, 2_000)).toBe(800_000n); // 20% slippage
  });

  it("floors at the full quote when no decay is allowed", () => {
    expect(minWbtcProfitFloor(1_000_000n, 0)).toBe(1_000_000n);
  });

  it("a 100% bound means no on-chain protection at all", () => {
    // Worth stating: with flash-swap funding this floor is the ONLY slippage bound, so 10_000 bps
    // disables the only thing standing between us and a bad fill.
    expect(minWbtcProfitFloor(1_000_000n, 10_000)).toBe(0n);
  });

  it("returns zero for a non-positive quote", () => {
    expect(minWbtcProfitFloor(0n, 1_000)).toBe(0n);
    expect(minWbtcProfitFloor(-5n, 1_000)).toBe(0n);
  });

  it("raises the floor to RISK_MIN_PROFIT when slippage alone would settle below it", () => {
    // The gap this closes: the gate admits on the quote (1.1M >= 1M) and then, without this, the
    // chain would accept 880_000 — below the minimum the operator declared.
    expect(minWbtcProfitFloor(1_100_000n, 2_000, 1_000_000n)).toBe(1_000_000n);
  });

  it("leaves the slippage bound alone when it already binds harder", () => {
    // A large position: 20% of 4M is a far tighter constraint than a 1_000-sat absolute floor, and
    // taking the absolute one would let the trade give up 3_999_000 sats and still succeed.
    expect(minWbtcProfitFloor(4_000_000n, 2_000, 1_000n)).toBe(3_200_000n);
  });

  it("is unchanged when no absolute floor is configured", () => {
    expect(minWbtcProfitFloor(1_000_000n, 2_000, undefined)).toBe(800_000n);
  });

  it("rejects an out-of-range slippage bound", () => {
    expect(() => minWbtcProfitFloor(1n, -1)).toThrow(ProbeError);
    expect(() => minWbtcProfitFloor(1n, 10_001)).toThrow(ProbeError);
    expect(() => minWbtcProfitFloor(1n, 1.5)).toThrow(ProbeError);
  });
});
