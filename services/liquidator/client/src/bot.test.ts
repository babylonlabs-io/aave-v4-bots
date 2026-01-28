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
  recordVaultsSeized: vi.fn(),
  recordVaultSwapped: vi.fn(),
  recordWbtcReceived: vi.fn(),
  recordError: vi.fn(),
  recordPollDuration: vi.fn(),
  recordTokenBalance: vi.fn(),
}));

const mockPosition: LiquidatablePosition = {
  proxyAddress: "0x1234567890123456789012345678901234567890",
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
      readContract: vi.fn().mockResolvedValue(BigInt("1000000000000000000")),
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
    controllerAddress: "0xcontroller" as `0x${string}`,
    vaultSwapAddress: "0xvaultswap" as `0x${string}`,
    wbtcAddress: "0xwbtc" as `0x${string}`,
    ponderUrl: "http://localhost:42069",
    autoSwap: false,
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

      // Should simulate + send liquidation tx
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
    it("sends liquidation with explicit nonce", async () => {
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
          args: [mockPosition.proxyAddress],
        })
      );
    });

    it("increments nonce for multiple positions", async () => {
      const clients = createMockClients();
      clients.publicClient.getTransactionCount.mockResolvedValue(10);

      const position2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
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

  describe("run() - auto-swap disabled", () => {
    it("does not swap vaults when autoSwap is false", async () => {
      const clients = createMockClients();
      const bot = createBot(clients, { autoSwap: false });

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

      // writeContract called once for liquidation, not for swap
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(1);
      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "liquidateCorePosition" })
      );
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

      // readContract for allowance + readContract for symbol + writeContract for approve + waitForReceipt
      expect(clients.publicClient.readContract).toHaveBeenCalled();
      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "approve",
        })
      );
    });

    it("skips approval when allowance is sufficient", async () => {
      const clients = createMockClients();
      // Return max uint256 allowance
      const maxUint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      clients.publicClient.readContract.mockResolvedValue(maxUint);

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await bot.ensureApproval();

      // No writeContract call for approve
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

      // Mock the chain of readContract calls:
      // 1. BTC_VAULT_CORE_SPOKE -> spoke address
      // 2. getReserveCount -> 2
      // 3. getReserve(0) -> borrowable
      // 4. symbol for reserve 0
      // 5. getReserve(1) -> not borrowable
      clients.publicClient.readContract
        .mockResolvedValueOnce("0xspoke") // BTC_VAULT_CORE_SPOKE
        .mockResolvedValueOnce(2n) // getReserveCount
        .mockResolvedValueOnce({ borrowable: true, underlying: "0xtoken1" }) // getReserve(0)
        .mockResolvedValueOnce("USDC") // symbol
        .mockResolvedValueOnce({ borrowable: false, underlying: "0xtoken2" }); // getReserve(1)

      const bot = createBot(clients);

      await bot.discoverDebtTokens();

      // Should have called readContract 5 times
      expect(clients.publicClient.readContract).toHaveBeenCalledTimes(5);
    });

    it("handles zero reserves gracefully", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract
        .mockResolvedValueOnce("0xspoke") // BTC_VAULT_CORE_SPOKE
        .mockResolvedValueOnce(0n); // getReserveCount = 0

      const bot = createBot(clients);

      await bot.discoverDebtTokens();

      // Only 2 calls: spoke address + reserve count
      expect(clients.publicClient.readContract).toHaveBeenCalledTimes(2);
    });
  });

  describe("listOwnedVaults()", () => {
    it("fetches and logs owned vaults from ponder", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [
              {
                vaultId: "0xvault1",
                owner: "0xliquidator",
                previousOwner: "0xprevious",
                updatedAt: "12345",
              },
            ],
          }),
      });

      // Should not throw
      await expect(bot.listOwnedVaults()).resolves.not.toThrow();

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/owned-vaults?owner="));
    });

    it("handles empty vault list", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [] }),
      });

      await expect(bot.listOwnedVaults()).resolves.not.toThrow();
    });

    it("handles ponder API failure", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(bot.listOwnedVaults()).resolves.not.toThrow();
    });
  });

  describe("swapSingleVault()", () => {
    it("swaps a vault for WBTC successfully", async () => {
      const clients = createMockClients();

      // balanceOf before and after
      clients.publicClient.readContract
        .mockResolvedValueOnce(100000000n) // balance before
        .mockResolvedValueOnce(200000000n); // balance after

      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 456n,
      });

      const bot = createBot(clients);
      const vaultId =
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`;

      await bot.swapSingleVault(vaultId);

      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapVaultForWbtc",
          args: [vaultId],
        })
      );
    });

    it("handles swap tx revert", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockResolvedValue(100000000n);
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 456n,
      });

      const bot = createBot(clients);

      await expect(bot.swapSingleVault("0xvault" as `0x${string}`)).resolves.not.toThrow();
    });

    it("handles swap failure gracefully", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockResolvedValue(100000000n);
      clients.walletClient.writeContract.mockRejectedValue(new Error("gas too low"));

      const bot = createBot(clients);

      await expect(bot.swapSingleVault("0xvault" as `0x${string}`)).resolves.not.toThrow();
    });
  });

  describe("logBalances()", () => {
    it("logs debt token and WBTC balances", async () => {
      const clients = createMockClients();

      // For debt token: balanceOf, symbol, decimals
      // For WBTC: balanceOf, symbol
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
