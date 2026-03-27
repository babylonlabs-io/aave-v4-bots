import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiquidationBot, type LiquidationBotConfig } from "./bot";
import type { LiquidatablePosition } from "./types";

// Mock metrics to avoid side effects
vi.mock("./metrics", () => ({
  recordPositionsChecked: vi.fn(),
  recordPositionsLiquidatable: vi.fn(),
  recordLiquidationSuccess: vi.fn(),
  recordLiquidationFailed: vi.fn(),
  recordSimulationFailed: vi.fn(),
  recordError: vi.fn(),
  recordPollDuration: vi.fn(),
  recordTokenBalance: vi.fn(),
}));

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

const mockInputs = [{ token: "0xUSDC" as `0x${string}`, amount: 1000000n }] as const;

const mockPosition: LiquidatablePosition = {
  proxyAddress: "0x1234567890123456789012345678901234567890",
  borrower: "0xborrower0000000000000000000000000000000001",
  healthFactor: "900000000000000000", // 0.9 (below 1.0)
  totalCollateralValue: "1000000000000000000",
  totalDebtValue: "500000000000000000",
  suppliedShares: "1000000000",
};

function createMockClients() {
  return {
    walletClient: {
      account: { address: "0xliquidator" as `0x${string}` },
      writeContract: vi.fn().mockResolvedValue("0xtxhash"),
    },
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({ result: true }),
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "estimateLiquidation") {
          return Promise.resolve([mockInputs, ["0xvault1"]]);
        }
        return Promise.resolve(BigInt("1000000000000000000"));
      }),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "success", blockNumber: 123n, logs: [] }),
    },
  };
}

function createBot(
  clients: ReturnType<typeof createMockClients>,
  overrides: Partial<LiquidationBotConfig> = {}
): LiquidationBot {
  return new LiquidationBot({
    logTag: "[TEST] ",
    walletClient: clients.walletClient as unknown as LiquidationBotConfig["walletClient"],
    publicClient: clients.publicClient as unknown as LiquidationBotConfig["publicClient"],
    adapterAddress: "0xadapter" as `0x${string}`,
    lensAddress: "0xlens" as `0x${string}`,
    wbtcAddress: "0xwbtc" as `0x${string}`,
    btcRedeemKey: ZERO_BYTES32,
    isDirectRedemption: false,
    ponderUrl: "http://localhost:42069",
    txReceiptTimeoutMs: 60000,
    ...overrides,
  });
}

describe("LiquidationBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("run() - ponder API handling", () => {
    it("processes positions when API returns liquidatable positions", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 10,
            checked: 10,
          }),
      });

      await bot.run();

      // Should call Lens estimate + simulate + send liquidation tx
      expect(clients.publicClient.readContract).toHaveBeenCalled();
      expect(clients.publicClient.simulateContract).toHaveBeenCalledOnce();
      expect(clients.walletClient.writeContract).toHaveBeenCalledOnce();
    });

    it("does nothing when no liquidatable positions found", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [],
            total: 10,
            checked: 10,
          }),
      });

      await bot.run();

      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("continues when ponder API fails (no crash)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(bot.run()).resolves.not.toThrow();
      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    });

    it("handles ponder API returning non-ok status", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(bot.run()).resolves.not.toThrow();
      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    });
  });

  describe("run() - Lens estimation", () => {
    it("skips positions where Lens estimate fails", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockRejectedValue(
        new Error("Position is not undercollateralized")
      );
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      // Should not simulate or send tx since Lens failed
      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe("run() - simulation filtering", () => {
    it("skips positions that fail simulation", async () => {
      const clients = createMockClients();
      clients.publicClient.simulateContract.mockRejectedValue(new Error("execution reverted"));
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      expect(clients.publicClient.simulateContract).toHaveBeenCalledOnce();
      // No tx sent since simulation failed
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("sends tx only for positions that pass simulation", async () => {
      const clients = createMockClients();

      const position2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        borrower: "0xborrower0000000000000000000000000000000002",
      };

      // First simulation succeeds, second fails
      clients.publicClient.simulateContract
        .mockResolvedValueOnce({ result: true })
        .mockRejectedValueOnce(new Error("reverted"));

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition, position2],
            total: 2,
            checked: 2,
          }),
      });

      await bot.run();

      expect(clients.publicClient.simulateContract).toHaveBeenCalledTimes(2);
      // Only 1 tx sent (first position)
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(1);
    });
  });

  describe("run() - transaction handling", () => {
    it("sends liquidation with borrower address and inputs from Lens", async () => {
      const clients = createMockClients();
      clients.publicClient.getTransactionCount.mockResolvedValue(42);
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: 42,
          functionName: "liquidateCorePosition",
          args: [mockPosition.borrower, ZERO_BYTES32, mockInputs],
        })
      );
    });

    it("sends liquidation with non-zero BTC redeem key when configured", async () => {
      const clients = createMockClients();
      clients.publicClient.getTransactionCount.mockResolvedValue(7);
      const nonZeroRedeemKey =
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;
      const bot = createBot(clients, { btcRedeemKey: nonZeroRedeemKey, isDirectRedemption: true });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: 7,
          functionName: "liquidateCorePosition",
          args: [mockPosition.borrower, nonZeroRedeemKey, mockInputs],
        })
      );
    });

    it("increments nonce for multiple positions", async () => {
      const clients = createMockClients();
      clients.publicClient.getTransactionCount.mockResolvedValue(10);

      const position2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        borrower: "0xborrower0000000000000000000000000000000002",
      };

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition, position2],
            total: 2,
            checked: 2,
          }),
      });

      await bot.run();

      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(2);
      expect(clients.walletClient.writeContract).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ nonce: 10 })
      );
      expect(clients.walletClient.writeContract).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ nonce: 11 })
      );
    });

    it("handles tx send failure gracefully (continues to next)", async () => {
      const clients = createMockClients();

      const position2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        borrower: "0xborrower0000000000000000000000000000000002",
      };

      // First writeContract fails, second succeeds
      clients.walletClient.writeContract
        .mockRejectedValueOnce(new Error("nonce too low"))
        .mockResolvedValueOnce("0xtxhash2");

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition, position2],
            total: 2,
            checked: 2,
          }),
      });

      await bot.run();

      // Both attempted
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(2);
      // Only one receipt waited for
      expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    });

    it("records failed liquidation when receipt shows reverted", async () => {
      const clients = createMockClients();
      const { recordLiquidationFailed } = await import("./metrics");

      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 123n,
        logs: [],
      });

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      expect(recordLiquidationFailed).toHaveBeenCalled();
    });

    it("records successful liquidation when receipt confirms", async () => {
      const clients = createMockClients();
      const { recordLiquidationSuccess } = await import("./metrics");

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            liquidatable: [mockPosition],
            total: 1,
            checked: 1,
          }),
      });

      await bot.run();

      expect(recordLiquidationSuccess).toHaveBeenCalled();
    });
  });

  describe("ensureApproval()", () => {
    it("approves when allowance is below threshold", async () => {
      const clients = createMockClients();
      // Return low allowance
      clients.publicClient.readContract.mockResolvedValue(0n);

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await bot.ensureApproval();

      expect(clients.publicClient.readContract).toHaveBeenCalled();
      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "approve",
        })
      );
    });

    it("skips approval when allowance is sufficient", async () => {
      const clients = createMockClients();
      const maxUint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      clients.publicClient.readContract.mockResolvedValue(maxUint);

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await bot.ensureApproval();

      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("does nothing when no debt tokens configured", async () => {
      const clients = createMockClients();
      const bot = createBot(clients, { debtTokenAddresses: [] });

      await bot.ensureApproval();

      expect(clients.publicClient.readContract).not.toHaveBeenCalled();
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe("discoverDebtTokens()", () => {
    it("discovers borrowable reserves from Spoke", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract
        .mockResolvedValueOnce("0xspoke") // BTC_VAULT_CORE_SPOKE
        .mockResolvedValueOnce(2n) // getReserveCount
        .mockResolvedValueOnce({ borrowable: true, underlying: "0xtoken1" }) // getReserve(0)
        .mockResolvedValueOnce("USDC") // symbol
        .mockResolvedValueOnce({ borrowable: false, underlying: "0xtoken2" }); // getReserve(1)

      const bot = createBot(clients);

      await bot.discoverDebtTokens();

      expect(clients.publicClient.readContract).toHaveBeenCalledTimes(5);
    });

    it("handles zero reserves gracefully", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract
        .mockResolvedValueOnce("0xspoke") // BTC_VAULT_CORE_SPOKE
        .mockResolvedValueOnce(0n); // getReserveCount = 0

      const bot = createBot(clients);

      await bot.discoverDebtTokens();

      expect(clients.publicClient.readContract).toHaveBeenCalledTimes(2);
    });
  });

  describe("logBalances()", () => {
    it("logs debt token and WBTC balances", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract
        .mockResolvedValueOnce(1000000n) // debt token balance
        .mockResolvedValueOnce("USDC") // debt token symbol
        .mockResolvedValueOnce(6) // debt token decimals
        .mockResolvedValueOnce(50000000n) // WBTC balance
        .mockResolvedValueOnce("WBTC"); // WBTC symbol

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await expect(bot.logBalances()).resolves.not.toThrow();

      const { recordTokenBalance } = await import("./metrics");
      expect(recordTokenBalance).toHaveBeenCalled();
    });
  });
});
