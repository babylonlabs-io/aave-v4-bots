import { createNonceAllocator, createNonceLease } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type MemoryStateStore, createMemoryStateStore } from "@repo/persistence";
import { createRiskGate } from "@repo/risk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArbitrageEngine, type ArbitrageEngineConfig } from "./engine";
import type { EscrowedVault } from "./types";

// Stub metrics port — the engine reports through it; tests assert on it directly.
// Recreated per test so call counts don't leak between cases.
function createMetrics() {
  return {
    recordVaultAcquired: vi.fn(),
    recordError: vi.fn(),
    recordPollDuration: vi.fn(),
    recordWbtcBalance: vi.fn(),
  };
}
const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let metrics: ReturnType<typeof createMetrics>;

const mockVault: EscrowedVault = {
  vaultId: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  btcAmount: "100000000", // 1 BTC
  currentDebt: "50000000", // 0.5 WBTC
  createdAt: "2024-01-01T00:00:00Z",
};

/**
 * A `TxSender` that skips real signing but honors the contract that matters: `onSigned` (the
 * durable nonce + hash record) runs BEFORE the broadcast resolves, so crash-safety tests
 * exercise the same ordering as the real sender.
 */
function mockSender() {
  return {
    send: vi.fn(
      async (
        call: { nonce?: number },
        onSigned?: (tx: {
          hash: `0x${string}`;
          nonce: number;
          serialized: `0x${string}`;
        }) => Promise<void>
      ) => {
        await onSigned?.({ hash: "0xtxhash", nonce: call.nonce ?? 0, serialized: "0xraw" });
        return "0xtxhash" as `0x${string}`;
      }
    ),
  };
}

function createMockClients() {
  return {
    sender: mockSender(),
    walletClient: {
      account: { address: "0xarbitrageur" },
      writeContract: vi.fn().mockResolvedValue("0xtxhash"), // approvals only
    },
    publicClient: {
      readContract: vi
        .fn()
        .mockImplementation(
          ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
            if (functionName === "previewEscrowedVaults") {
              const vaultIds = args[0] as readonly `0x${string}`[];
              return Promise.resolve(
                vaultIds.map((vaultId) => ({
                  vaultId,
                  amountVault: 100000000n,
                  amountDebt: 50000000n,
                  amountInterest: 0n,
                  amountFee: 0n,
                  amountWbtcEquivalent: 100000000n,
                  amountWbtcToAcquire: 50000000n,
                  amountProfitEst: 50000000n,
                }))
              );
            }
            if (functionName === "allowance") {
              return Promise.resolve(BigInt("1000000000000")); // High allowance
            }
            return Promise.resolve(0n);
          }
        ),
      estimateContractGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "success", blockNumber: 123n }),
    },
  };
}

function createBot(
  clients: ReturnType<typeof createMockClients>,
  overrides: Partial<ArbitrageEngineConfig> = {}
): ArbitrageEngine {
  return new ArbitrageEngine({
    walletClient: clients.walletClient as unknown as ArbitrageEngineConfig["walletClient"],
    publicClient: clients.publicClient as unknown as ArbitrageEngineConfig["publicClient"],
    sender: clients.sender as unknown as ArbitrageEngineConfig["sender"],
    vaultSwapAddress: "0xvaultswap",
    wbtcAddress: "0xwbtc",
    ponderUrl: "http://localhost:42070",
    maxSlippageBps: 100,
    vaultProcessingDelayMs: 0,
    retryConfig: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
    txReceiptTimeoutMs: 1000,
    metrics,
    logger: silentLogger,
    risk: createRiskGate(), // permissive by default
    ...overrides,
  });
}

describe("ArbitrageEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics = createMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("contract interactions", () => {
    it("acquires vault successfully: estimates gas, writes contract, waits for receipt", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("acquired");
      expect(clients.publicClient.estimateContractGas).toHaveBeenCalledOnce();
      expect(clients.sender.send).toHaveBeenCalledOnce();
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVault",
          args: [mockVault.vaultId, 50500000n], // 0.5 WBTC debt + 1% slippage
        }),
        expect.any(Function)
      );
      expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: "0xtxhash",
      });
    });

    it("skips vault when gas estimation fails (no tx sent)", async () => {
      const clients = createMockClients();
      clients.publicClient.estimateContractGas.mockRejectedValue(new Error("execution reverted"));
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("skips vault when not profitable for arbitrageur", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          if (functionName === "previewEscrowedVaults") {
            const vaultIds = args[0] as readonly `0x${string}`[];
            return Promise.resolve(
              vaultIds.map((vaultId) => ({
                vaultId,
                amountVault: 100000000n,
                amountDebt: 100000n,
                amountInterest: 1000n,
                amountFee: 10n,
                amountWbtcEquivalent: 100000n,
                amountWbtcToAcquire: 100010n,
                amountProfitEst: 0n,
              }))
            );
          }
          if (functionName === "allowance") {
            return Promise.resolve(BigInt("1000000000000"));
          }
          return Promise.resolve(0n);
        }
      );

      const bot = createBot(clients);
      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
      expect(clients.publicClient.estimateContractGas).not.toHaveBeenCalled();
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("handles contract revert after tx sent", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 123n,
      });
      const bot = createBot(clients);

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
      expect(clients.sender.send).toHaveBeenCalled();
    });

    it("handles tx timeout gracefully (returns false, continues)", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      );
      const bot = createBot(clients, { txReceiptTimeoutMs: 50 });

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
    });

    it("approves WBTC when allowance insufficient", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          if (functionName === "previewEscrowedVaults") {
            const vaultIds = args[0] as readonly `0x${string}`[];
            return Promise.resolve(
              vaultIds.map((vaultId) => ({
                vaultId,
                amountVault: 100000000n,
                amountDebt: 50000000n,
                amountInterest: 0n,
                amountFee: 0n,
                amountWbtcEquivalent: 100000000n,
                amountWbtcToAcquire: 50000000n,
                amountProfitEst: 50000000n,
              }))
            );
          }
          if (functionName === "allowance") {
            return Promise.resolve(0n); // No allowance
          }
          return Promise.resolve(0n);
        }
      );
      const bot = createBot(clients);

      await bot.acquireVault(mockVault);

      // Approval still goes through writeContract; the swap goes through the TxSender.
      expect(clients.walletClient.writeContract).toHaveBeenCalledOnce();
      expect(clients.sender.send).toHaveBeenCalledOnce();
    });

    it("approves when allowance covers debt but not slippage-adjusted maxWbtcIn", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          if (functionName === "previewEscrowedVaults") {
            const vaultIds = args[0] as readonly `0x${string}`[];
            return Promise.resolve(
              vaultIds.map((vaultId) => ({
                vaultId,
                amountVault: 100000000n,
                amountDebt: 50000000n,
                amountInterest: 0n,
                amountFee: 0n,
                amountWbtcEquivalent: 100000000n,
                amountWbtcToAcquire: 50000000n,
                amountProfitEst: 50000000n,
              }))
            );
          }
          if (functionName === "allowance") {
            return Promise.resolve(50000000n); // equals currentDebt, but < maxWbtcIn with 1% slippage
          }
          return Promise.resolve(0n);
        }
      );

      const bot = createBot(clients, { maxSlippageBps: 100 });
      await bot.acquireVault(mockVault);

      // Should still approve because swap uses maxWbtcIn, not currentDebt
      expect(clients.walletClient.writeContract).toHaveBeenCalledOnce();
      expect(clients.sender.send).toHaveBeenCalledOnce();
    });

    it("uses debt as maxWbtcIn when slippage floor division rounds to zero", async () => {
      const clients = createMockClients();
      const tinyVault: EscrowedVault = {
        ...mockVault,
        currentDebt: "1",
      };
      const bot = createBot(clients, { maxSlippageBps: 1 }); // 0.01%

      const result = await bot.acquireVault(tinyVault);

      expect(result).toBe("acquired");
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVault",
          args: [tinyVault.vaultId, 1n],
        }),
        expect.any(Function)
      );
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

      expect(clients.sender.send).toHaveBeenCalled();
    });

    it("handles empty vault list gracefully", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [], total: 0 }),
      });

      await bot.run();

      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("continues operation when API fails (returns empty, no crash)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      // Should not throw
      await expect(bot.run()).resolves.not.toThrow();
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("handles malformed API response", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: "data" }),
      });

      // Should not throw and should not attempt any swaps
      await expect(bot.run()).resolves.not.toThrow();
      expect(clients.sender.send).not.toHaveBeenCalled();
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
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
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
      expect(clients.sender.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("risk gate", () => {
    it("blocks an acquisition when the gate is HALTED (no tx)", async () => {
      const clients = createMockClients();
      const risk = createRiskGate();
      risk.halt("manual");
      const bot = createBot(clients, { risk });

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("trips the breaker after a reverted acquisition", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 1n,
      });
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });

      await bot.acquireVault(mockVault); // reverts → recordOutcome(false) → breaker trips
      expect(risk.state()).toBe("HALTED");
    });
  });

  describe("crash-safety + nonce allocator", () => {
    function storeBot(store: MemoryStateStore, seedNonce = 5) {
      const clients = createMockClients();
      (clients.walletClient as { chain?: { id: number } }).chain = { id: 31337 };
      const nonces = createNonceAllocator(createNonceLease(), "0xarbitrageur");
      const bot = createBot(clients, { store, nonces });
      return { bot, clients, nonces, seedNonce };
    }

    it("records an intent and routes the swap through the allocator", async () => {
      const store = createMemoryStateStore();
      const { bot, clients, nonces } = storeBot(store);
      await nonces.resync(() => Promise.resolve(5)); // seed the lease (run() would do this at cycle start)

      const ok = await bot.acquireVault(mockVault);

      expect(ok).toBe("acquired");
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "swapWbtcForVault", nonce: 5 }),
        expect.any(Function)
      );
      const intent = store.all()[0];
      expect(intent?.status).toBe("confirmed");
    });

    it("refuses a duplicate live acquisition (no second swap)", async () => {
      const store = createMemoryStateStore();
      const { bot, clients, nonces } = storeBot(store);
      await nonces.resync(() => Promise.resolve(5));

      // Pre-record the vault as live (as if a prior cycle's swap is in flight).
      await store.recordIntent({
        chainId: 31337,
        target: "0xvaultswap",
        action: "vault-acquisition",
        subject: mockVault.vaultId,
      });

      const ok = await bot.acquireVault(mockVault);

      expect(ok).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("intent_in_flight");
    });

    it("keeps the intent live (not terminal) on an ambiguous send error", async () => {
      const store = createMemoryStateStore();
      const { bot, clients, nonces } = storeBot(store);
      await nonces.resync(() => Promise.resolve(5));
      clients.sender.send = vi.fn(
        async (
          call: { nonce?: number },
          onSigned?: (tx: {
            hash: `0x${string}`;
            nonce: number;
            serialized: `0x${string}`;
          }) => Promise<void>
        ) => {
          // Ambiguous send: signed + durably recorded, then the broadcast blows up.
          await onSigned?.({ hash: "0xtxhash", nonce: call.nonce ?? 0, serialized: "0xraw" });
          throw new Error("rpc timeout");
        }
      );

      const ok = await bot.acquireVault(mockVault);

      expect(ok).toBe("send-error");
      const intent = store.all()[0];
      expect(intent?.status).toBe("submitted"); // live, not "failed"
      expect(intent?.nonce).toBe(5); // reserved nonce persisted for reconcile
      // The hash was signed and recorded before the broadcast, so reconcile can resolve this
      // ambiguous send by receipt lookup instead of guessing from the nonce.
      expect(intent?.txHash).toBe("0xtxhash");
    });

    it("run() stops the cycle after a send error (does not process later vaults)", async () => {
      const store = createMemoryStateStore();
      const { bot, clients } = storeBot(store);
      // run() reseeds the lease from the chain each cycle.
      (clients.publicClient as { getTransactionCount?: unknown }).getTransactionCount = vi
        .fn()
        .mockResolvedValue(5);
      // The first swap throws (ambiguous); the loop must break, not try the second vault.
      clients.sender.send = vi.fn().mockRejectedValue(new Error("rpc timeout"));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [mockVault, { ...mockVault, vaultId: `0x${"c".repeat(64)}` }],
          }),
      }) as unknown as typeof fetch;

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledTimes(1);
    });
  });
});
