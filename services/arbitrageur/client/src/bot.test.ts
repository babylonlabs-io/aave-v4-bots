import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArbitrageurBot, type ArbitrageurBotConfig } from "./bot";
import type { EscrowedVault } from "./types";

// Mock metrics to avoid side effects
vi.mock("./metrics", () => ({
  recordVaultAcquired: vi.fn(),
  recordError: vi.fn(),
  recordPollDuration: vi.fn(),
}));

vi.mock("./health", () => ({
  updateLastPollTime: vi.fn(),
}));

const mockVault: EscrowedVault = {
  vaultId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  seller: "0x1234567890123456789012345678901234567890",
  btcAmount: "100000000n", // 1 BTC
  currentDebt: "50000000n", // 0.5 WBTC
  createdAt: "2024-01-01T00:00:00Z",
};

function createMockClients() {
  return {
    walletClient: {
      account: { address: "0xarbitrageur" },
      writeContract: vi.fn().mockResolvedValue("0xtxhash"),
    },
    publicClient: {
      readContract: vi.fn().mockResolvedValue(BigInt("1000000000000")), // High allowance
      estimateContractGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "success", blockNumber: 123n }),
    },
  };
}

function createBot(
  clients: ReturnType<typeof createMockClients>,
  overrides: Partial<ArbitrageurBotConfig> = {}
): ArbitrageurBot {
  return new ArbitrageurBot({
    logTag: "[TEST] ",
    walletClient: clients.walletClient as unknown as ArbitrageurBotConfig["walletClient"],
    publicClient: clients.publicClient as unknown as ArbitrageurBotConfig["publicClient"],
    controllerAddress: "0xcontroller",
    vaultSwapAddress: "0xvaultswap",
    wbtcAddress: "0xwbtc",
    ponderUrl: "http://localhost:42070",
    maxSlippageBps: 100,
    autoRedeem: false,
    vaultProcessingDelayMs: 0,
    retryConfig: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
    txReceiptTimeoutMs: 1000,
    ...overrides,
  });
}

describe("ArbitrageurBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("contract interactions", () => {
    it("acquires vault successfully: estimates gas, writes contract, waits for receipt", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe(true);
      expect(clients.publicClient.estimateContractGas).toHaveBeenCalledOnce();
      expect(clients.walletClient.writeContract).toHaveBeenCalledOnce();
      expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: "0xtxhash",
      });
      expect(bot.getOwnedVaults()).toHaveLength(1);
    });

    it("skips vault when gas estimation fails (no tx sent)", async () => {
      const clients = createMockClients();
      clients.publicClient.estimateContractGas.mockRejectedValue(new Error("execution reverted"));
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe(false);
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
      expect(bot.getOwnedVaults()).toHaveLength(0);
    });

    it("handles contract revert after tx sent", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 123n,
      });
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe(false);
      expect(clients.walletClient.writeContract).toHaveBeenCalled();
    });

    it("handles tx timeout gracefully (returns false, continues)", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      );
      const bot = createBot(clients, { txReceiptTimeoutMs: 50 });

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe(false);
    });

    it("approves WBTC when allowance insufficient", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockResolvedValue(0n); // No allowance
      const bot = createBot(clients);

      await bot.acquireVault(mockVault);

      // Should have 2 writeContract calls: approve + swap
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(2);
    });
  });

  describe("ponder API handling", () => {
    it("processes vaults when API returns valid data", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      expect(clients.walletClient.writeContract).toHaveBeenCalled();
    });

    it("handles empty vault list gracefully", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [], total: 0 }),
      });

      await bot.run();

      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("continues operation when API fails (returns empty, no crash)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      // Should not throw
      await expect(bot.run()).resolves.not.toThrow();
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("handles malformed API response", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: "data" }),
      });

      // Should not throw, but won't process anything
      await expect(bot.run()).resolves.not.toThrow();
    });
  });

  describe("bot state machine", () => {
    it("processes multiple vaults sequentially", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      const vault2 = { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault, vault2], total: 2 }),
      });

      await bot.run();

      // 2 vaults = 2 swap transactions (no approval needed, high allowance)
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(2);
      expect(bot.getOwnedVaults()).toHaveLength(2);
    });

    it("continues to next vault when one fails", async () => {
      const clients = createMockClients();
      const vault2 = { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` };

      // First vault fails gas estimation, second succeeds
      clients.publicClient.estimateContractGas
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(100000n);

      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault, vault2], total: 2 }),
      });

      await bot.run();

      // Only 1 tx sent (second vault)
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(1);
      expect(bot.getOwnedVaults()).toHaveLength(1);
    });

    it("triggers auto-redeem after successful acquisition when enabled", async () => {
      const clients = createMockClients();
      const bot = createBot(clients, { autoRedeem: true });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      // 2 transactions: swap + redeem (both estimate gas first)
      expect(clients.publicClient.estimateContractGas).toHaveBeenCalledTimes(2);
      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(2);
    });

    it("tracks owned vaults correctly across multiple runs", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      const vault2 = { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` };

      // Run 1: acquire vault1
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });
      await bot.run();

      // Run 2: acquire vault2
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [vault2], total: 1 }),
      });
      await bot.run();

      // Should have both vaults tracked
      expect(bot.getOwnedVaults()).toHaveLength(2);
    });
  });
});
