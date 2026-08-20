import { VenueType, liquidationRouterAbi } from "@repo/abis";
import { createRiskGate } from "@repo/risk";
import { type Address, BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createIndexerClient } from "../shared/indexerClient";
import { LiquidationEngine, type LiquidationEngineConfig } from "./engine";

/**
 * The indexer as these tests drive it: a real client bound to a dummy base, so the existing
 * `global.fetch` mocks (and the failure cases that reject) still exercise the same path.
 */
const INDEXER_STUB = {
  ...createIndexerClient({ baseUrl: "http://indexer", retry: { maxAttempts: 1 } }),
  // The guard is unconfigured in these tests, which is the state it reports as "go ahead".
  ok: async () => true,
};

/**
 * The engine's `flash` branch, end to end from a Ponder response to a committed call.
 *
 * The point of these is the *difference* from the inventory path: what the risk gate is told, and
 * which contract gets called. The inventory path's own coverage lives in engine.test.ts.
 */

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ROUTER = "0x9999999999999999999999999999999999999999" as Address;
const VENUE = "0x1111111111111111111111111111111111111111" as Address;
const MORPHO = "0x2222222222222222222222222222222222222222" as Address;
const ADAPTER = "0x3333333333333333333333333333333333333333" as Address;
const LENS = "0x4444444444444444444444444444444444444444" as Address;
const BORROWER = "0x5555555555555555555555555555555555555555" as Address;
const PROXY = "0x6666666666666666666666666666666666666666" as Address;

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

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A probe revert carrying `net` realised WBTC against one WBTC-denominated venue debt. */
function belovedRevert(net: bigint, debt: bigint) {
  return new BaseError("execution reverted", {
    cause: new ContractFunctionRevertedError({
      abi: liquidationRouterAbi as unknown as never,
      data: encodeErrorResult({
        abi: liquidationRouterAbi,
        errorName: "BelovedError",
        args: [net, [{ token: WBTC, venue: VENUE, amount: debt }]],
      }),
      functionName: "liquidate",
    }),
  });
}

function harness(
  opts: {
    net?: bigint;
    debt?: bigint;
    probeError?: unknown;
    risk?: ReturnType<typeof createRiskGate>;
    /** WBTC the router already holds when the cycle starts. */
    routerBalance?: bigint;
    /** Make the router's balance read fail, as an RPC outage would. */
    balanceError?: boolean;
  } = {}
) {
  const commit = vi.fn().mockResolvedValue({ kind: "broadcast", hash: "0xtx", intentId: "i" });
  const simulateContract = vi
    .fn()
    .mockRejectedValue(
      opts.probeError ?? belovedRevert(opts.net ?? 1_000_000n, opts.debt ?? 600_000n)
    );

  const publicClient = {
    simulateContract,
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "estimateLiquidation") return [[100n], 50n, []];
      if (functionName === "balanceOf") {
        if (opts.balanceError) throw new Error("connect ECONNREFUSED");
        return opts.routerBalance ?? 0n; // by default the router holds nothing
      }
      if (functionName === "getPosition") return { proxyContract: PROXY, totalCollateralBTC: 1n };
      return 0n;
    }),
    waitForTransactionReceipt: vi
      .fn()
      .mockResolvedValue({ status: "success", blockNumber: 1n, logs: [] }),
  };

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      liquidatable: [{ borrower: BORROWER, proxyAddress: PROXY }],
      checked: 1,
      dataTimestampMs: Date.now(),
    }),
  }) as unknown as typeof global.fetch;

  const metrics = {
    recordError: vi.fn(),
    recordLiquidationSuccess: vi.fn(),
    recordLiquidationFailed: vi.fn(),
    recordSimulationFailed: vi.fn(),
    recordPollDuration: vi.fn(),
    recordPositionsChecked: vi.fn(),
    recordPositionsLiquidatable: vi.fn(),
    recordTokenBalance: vi.fn(),
  };

  const engine = new LiquidationEngine({
    publicClient: publicClient as unknown as LiquidationEngineConfig["publicClient"],
    adapterAddress: ADAPTER,
    lensAddress: LENS,
    wbtcAddress: WBTC,
    btcRedeemKey: `0x${"00".repeat(32)}`,
    isDirectRedemption: false,
    llpAddress: VENUE,
    indexer: INDEXER_STUB,
    txReceiptTimeoutMs: 1000,
    funding: { mode: "flash", routerAddress: ROUTER, venues, maxSlippageBps: 2_000 },
    metrics,
    logger: silentLogger,
    risk: opts.risk ?? createRiskGate(),
    executor: {
      mode: "AUTO",
      identity: { from: ROUTER, chainId: 31337 },
      commit,
      reconcile: vi.fn(),
      resyncNonces: vi.fn(),
      recordOutcome: vi.fn(),
      ensureAllowance: vi.fn(),
    } as unknown as LiquidationEngineConfig["executor"],
  });

  return { engine, commit, simulateContract, metrics };
}

describe("liquidation engine — flash funding", () => {
  it("calls the router, not the adapter", async () => {
    const { engine, commit } = harness();
    await engine.run();

    expect(commit).toHaveBeenCalledTimes(1);
    const [call, claim] = commit.mock.calls[0];
    expect(call.address).toBe(ROUTER);
    expect(call.functionName).toBe("liquidate");
    // The intent's target must follow the call, or reconcile attributes it to the wrong contract.
    expect(claim.target).toBe(ROUTER);
  });

  it("carries RISK_MIN_PROFIT into the on-chain floor when it binds harder", async () => {
    // The gate admits on the quote and then stops constraining anything, so without this the tx
    // could settle below the minimum the operator declared. 400_000 profit, 20% slippage => 320_000,
    // but the operator said never below 350_000.
    const { engine, commit } = harness({
      net: 1_000_000n,
      debt: 600_000n,
      risk: createRiskGate({ minProfit: 350_000n }),
    });
    await engine.run();

    const [call] = commit.mock.calls[0];
    const [liquidationData] = call.args;
    expect(liquidationData.minWbtcProfit).toBe(350_000n);
  });

  it("sends empty swapDatas and a floor derived from the quote", async () => {
    // 1_000_000 realised - 600_000 owed = 400_000 profit; a 20% slippage bound floors it at 320_000.
    const { engine, commit } = harness({ net: 1_000_000n, debt: 600_000n });
    await engine.run();

    const [call] = commit.mock.calls[0];
    const [liquidationData, flashDatas, swapDatas] = call.args;
    expect(liquidationData.minWbtcProfit).toBe(320_000n);
    expect(swapDatas).toEqual([]);
    // USDC via flash swap, then WBTC via flash loan for the fairness payment.
    expect(flashDatas.map((f: { token: Address }) => f.token)).toEqual([USDC, WBTC]);
  });

  it("declares expectedProfit and no spend to the risk gate", async () => {
    // The heart of the mode: the router funds itself, so reserving the signer's inventory would
    // block the arbitrage engine for balances this tx never touches — while the probe finally makes
    // a real profit figure available.
    const risk = createRiskGate();
    const openSlot = vi.spyOn(risk, "openSlot");
    const { engine } = harness({ risk });

    await engine.run();

    expect(openSlot).toHaveBeenCalledTimes(1);
    const action = openSlot.mock.calls[0][0];
    expect(action.expectedProfit).toBe(400_000n);
    expect(action.spend).toBeUndefined();
  });

  it("skips a candidate the probe prices at a loss", async () => {
    const { engine, commit } = harness({ net: 500_000n, debt: 600_000n });
    await engine.run();

    expect(commit).not.toHaveBeenCalled();
  });

  it("skips a candidate the router refuses, without sending", async () => {
    // Any revert that is not BelovedError — position already taken, dry venue, bad pool key.
    const notBeloved = new BaseError("execution reverted", {
      cause: new ContractFunctionRevertedError({
        abi: liquidationRouterAbi as unknown as never,
        data: "0xdeadbeef",
        functionName: "liquidate",
      }),
    });
    const { engine, commit } = harness({ probeError: notBeloved });
    await engine.run();

    expect(commit).not.toHaveBeenCalled();
  });

  it("does not send when the probe itself fails", async () => {
    // An RPC outage is a malfunction, not a verdict: it must not be read as "unprofitable".
    const { engine, commit } = harness({ probeError: new Error("connect ECONNREFUSED") });
    await engine.run();

    expect(commit).not.toHaveBeenCalled();
  });

  // The router's WBTC baseline. Both halves of the floor are measured net of it — the quote here,
  // the delta on chain — so a donation neither inflates the profit we report nor pays for the guard.
  describe("the router's pre-existing WBTC balance", () => {
    it("is netted out of the quote and the floor", async () => {
      // 1_000_000 raw - 250_000 already held = 750_000 realised; less 600_000 owed = 150_000 profit,
      // floored at 20% slippage to 120_000. Without the subtraction this quotes 400_000/320_000.
      const { engine, commit } = harness({
        net: 1_000_000n,
        debt: 600_000n,
        routerBalance: 250_000n,
      });
      await engine.run();

      const [call] = commit.mock.calls[0];
      expect(call.args[0].minWbtcProfit).toBe(120_000n);
    });

    it("skips the cycle when it cannot be read, rather than assuming zero", async () => {
      // Assuming zero is not the safe guess it looks like: it *overstates* realised profit by
      // whatever the router holds, so the gate would admit a liquidation on profit that is not there.
      const { engine, commit, metrics } = harness({ balanceError: true });
      await engine.run();

      expect(commit).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("router_balance_read_error");
    });
  });

  it("rejects an invalid venue registry at construction", () => {
    // Better here than as a revert inside a venue callback on the one candidate that mattered.
    expect(
      () =>
        new LiquidationEngine({
          ...({} as LiquidationEngineConfig),
          publicClient: {} as LiquidationEngineConfig["publicClient"],
          adapterAddress: ADAPTER,
          lensAddress: LENS,
          wbtcAddress: WBTC,
          btcRedeemKey: `0x${"00".repeat(32)}`,
          isDirectRedemption: false,
          llpAddress: VENUE,
          indexer: INDEXER_STUB,
          txReceiptTimeoutMs: 1,
          logger: silentLogger,
          funding: {
            mode: "flash",
            routerAddress: ROUTER,
            maxSlippageBps: 0,
            venues: {
              ...venues,
              // USDC/USDC is not a WBTC pair — the flash swap would leave a non-WBTC debt.
              flashSwaps: [
                {
                  ...venues.flashSwaps[0],
                  poolKey: { ...venues.flashSwaps[0].poolKey, currency0: USDC },
                },
              ],
            },
          },
        })
    ).toThrow(/^I3/);
  });
});
