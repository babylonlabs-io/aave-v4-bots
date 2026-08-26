import { type NonceAllocator, createNonceAllocator, createNonceLease } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type MemoryStateStore, type StateStore, createMemoryStateStore } from "@repo/persistence";
import { createRiskGate } from "@repo/risk";
import { TransactionReceiptNotFoundError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoExecutorWithSender } from "../shared/executorTestKit";
import { createIndexerClient } from "../shared/indexerClient";
import { ArbitrageEngine, type ArbitrageEngineConfig } from "./engine";
import type { EscrowedVault } from "./types";

/**
 * The indexer as these tests drive it: a real client bound to a dummy base, so the existing
 * `global.fetch` mocks (and the failure cases that reject) still exercise the same path.
 */
const INDEXER_STUB = {
  ...createIndexerClient({ baseUrl: "http://indexer", retry: { maxAttempts: 1 } }),
  // The guard is unconfigured in these tests, which is the state it reports as "go ahead".
  ok: async () => true,
};

// Stub metrics port — the engine reports through it; tests assert on it directly.
// Recreated per test so call counts don't leak between cases.
function createMetrics() {
  return {
    recordVaultAcquired: vi.fn(),
    recordError: vi.fn(),
    recordPollDuration: vi.fn(),
    recordWbtcBalance: vi.fn(),
    recordFundingCapacity: vi.fn(),
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
/** The signer pays under inventory funding, so it is the account the gate reserves against. */
const WBTC_ACCOUNT = { owner: "0xarbitrageur", token: "0xwbtc" };

function mockSender(identity = { from: "0xarbitrageur" as `0x${string}`, chainId: 31337 }) {
  return {
    identity,
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
      // A real `WalletClient<Transport, Chain, Account>` always has a chain; the engine reads
      // `chain.id` for the intent's idempotency key.
      chain: { id: 31337 },
      writeContract: vi.fn().mockResolvedValue("0xtxhash"), // approvals only
    },
    publicClient: {
      readContract: vi
        .fn()
        .mockImplementation(
          ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
            // The batch path budgets acquisitions against real WBTC inventory, so a
            // zero balance now (correctly) blocks every send. Fund the fixture.
            if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
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
            // Default: the vault is still acquirable, so a reverted swap reads as a genuine failure
            // (a lost-race test overrides this to false).
            if (functionName === "isVaultAcquirable") {
              return Promise.resolve(true);
            }
            return Promise.resolve(0n);
          }
        ),
      estimateContractGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi
        .fn()
        .mockImplementation(({ hash }: { hash: string }) =>
          Promise.resolve({ status: "success", blockNumber: 123n, transactionHash: hash })
        ),
      // Inventory refresh pins every balance to one height, and the gate's outflow holds are
      // retired against it — see `retireSettledOutflows`.
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", blockNumber: 123n }),
    },
  };
}

/**
 * A pre-seeded pass-through allocator: hands out nonce 0 and treats `resync` as a no-op. The
 * default for tests that drive `acquireVault` directly (no `run()` to seed the lease from the
 * chain); the crash-safety / nonce-sequencing tests inject a real allocator instead.
 */
const passthroughNonces = (): NonceAllocator => ({
  withNonce: (send) => send(0),
  resync: async () => {},
});

type AutoDeps = Parameters<typeof createAutoExecutorWithSender>[0];

/**
 * Build the engine with a default AUTO executor over the mock wallet + sender (the composition the
 * `@repo/runtime` root does in production), unless a test injects its own `executor`. `store`/`nonces`
 * steer the executor's crash-safety + nonce plumbing; `nonces` defaults to the pass-through allocator.
 */
function createBot(
  clients: ReturnType<typeof createMockClients>,
  overrides: Partial<ArbitrageEngineConfig> & {
    store?: StateStore;
    nonces?: NonceAllocator;
  } = {}
): ArbitrageEngine {
  const { store, nonces, executor, ...engineOverrides } = overrides;
  // `run()` publishes the signer's WBTC balance to the gate each cycle; tests that drive
  // `acquireVault` directly skip that, and the gate fails closed on a token it has no balance for.
  // Seed it here so those tests exercise the acquisition path rather than the inventory guard —
  // the inventory tests set their own figure explicitly.
  const risk = engineOverrides.risk ?? createRiskGate();
  risk.setAvailable(WBTC_ACCOUNT, 10n ** 24n);
  return new ArbitrageEngine({
    publicClient: clients.publicClient as unknown as ArbitrageEngineConfig["publicClient"],
    vaultSwapAddress: "0xvaultswap",
    wbtcAddress: "0xwbtc",
    indexer: INDEXER_STUB,
    maxSlippageBps: 100,
    vaultProcessingDelayMs: 0,
    txReceiptTimeoutMs: 1000,
    metrics,
    logger: silentLogger,
    executor:
      executor ??
      createAutoExecutorWithSender({
        store,
        nonces: nonces ?? passthroughNonces(),
        sender: clients.sender as unknown as AutoDeps["sender"],
        publicClient: clients.publicClient as unknown as AutoDeps["publicClient"],
        walletClient: clients.walletClient as unknown as AutoDeps["walletClient"],
        txReceiptTimeoutMs: 1000,
        logger: silentLogger,
      }),
    ...engineOverrides,
    risk,
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
          // The batch path budgets acquisitions against real WBTC inventory, so a
          // zero balance now (correctly) blocks every send. Fund the fixture.
          if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
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
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 123n, transactionHash: hash })
      );
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
          // The batch path budgets acquisitions against real WBTC inventory, so a
          // zero balance now (correctly) blocks every send. Fund the fixture.
          if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
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

      // Both the approval and the swap go through the TxSender, so one submission policy covers
      // every transaction the signer sends.
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "approve" }),
        expect.any(Function)
      );
      expect(clients.walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("approves when allowance covers debt but not slippage-adjusted maxWbtcIn", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          // The batch path budgets acquisitions against real WBTC inventory, so a
          // zero balance now (correctly) blocks every send. Fund the fixture.
          if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
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

      // Should still approve because swap uses maxWbtcIn, not currentDebt — approval + swap.
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "approve" }),
        expect.any(Function)
      );
    });

    it("uses debt as maxWbtcIn when slippage floor division rounds to zero", async () => {
      const clients = createMockClients();
      // The ceiling is priced off the FRESH preview, not the indexer's `currentDebt`, so the tiny
      // cost has to come from the preview for this rounding case to be exercised at all.
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
          if (functionName === "allowance") return Promise.resolve(BigInt("1000000000000"));
          if (functionName === "isVaultAcquirable") return Promise.resolve(true);
          if (functionName === "previewEscrowedVaults") {
            const vaultIds = args[0] as readonly `0x${string}`[];
            return Promise.resolve(
              vaultIds.map((vaultId) => ({
                vaultId,
                amountVault: 100000000n,
                amountDebt: 1n,
                amountInterest: 0n,
                amountFee: 0n,
                amountWbtcEquivalent: 100000000n,
                amountWbtcToAcquire: 1n,
                amountProfitEst: 50000000n,
              }))
            );
          }
          return Promise.resolve(0n);
        }
      );
      const bot = createBot(clients, { maxSlippageBps: 1 }); // 0.01%

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("acquired");
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVault",
          args: [mockVault.vaultId, 1n],
        }),
        expect.any(Function)
      );
    });

    it("prices the ceiling off the fresh preview, not the indexer's stale debt", async () => {
      const clients = createMockClients();
      // Escrow debt only accrues, so a lagging indexer reports it LOW. Pricing off it would set the
      // ceiling under the real cost — the swap reverts, and a revert with the vault still in escrow
      // is not a lost race, so it would feed the breaker.
      const staleVault: EscrowedVault = { ...mockVault, currentDebt: "1000" };
      const bot = createBot(clients);

      await bot.acquireVault(staleVault);

      // Fixture preview cost is 50_000_000 (+1% = 50_500_000); the stale 1000 must not be used.
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ args: [staleVault.vaultId, 50500000n] }),
        expect.any(Function)
      );
    });
  });

  describe("acquiring on behalf of a vault keeper", () => {
    const KEEPER = "0xkeeper" as const;
    // 0.5 WBTC debt + 1% slippage — the same ceiling the direct-path tests assert.
    const MAX_WBTC_IN = 50500000n;

    it("uses swapWbtcForVault when no keeper is configured (the payer IS the keeper)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);

      await bot.acquireVault(mockVault);

      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVault",
          args: [mockVault.vaultId, MAX_WBTC_IN],
        }),
        expect.any(Function)
      );
    });

    it("uses swapWbtcForVaultOnBehalf when a keeper is configured", async () => {
      const clients = createMockClients();
      const bot = createBot(clients, { vaultKeeperAddress: KEEPER });

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("acquired");
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVaultOnBehalf",
          args: [mockVault.vaultId, MAX_WBTC_IN, KEEPER],
        }),
        expect.any(Function)
      );
    });

    it("estimates gas for the same call it broadcasts", async () => {
      // The estimate is the pre-flight check for the tx that follows it. If it validated the
      // direct call while the on-behalf call went out, a bad keeper would slip past the estimate
      // and surface as an on-chain revert instead of a cheap skip.
      const clients = createMockClients();
      const bot = createBot(clients, { vaultKeeperAddress: KEEPER });

      await bot.acquireVault(mockVault);

      expect(clients.publicClient.estimateContractGas).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "swapWbtcForVaultOnBehalf",
          args: [mockVault.vaultId, MAX_WBTC_IN, KEEPER],
        })
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

    // A vault the indexer could not read is dropped from the list, not marked in it, so a short
    // list reads exactly like a complete one. The count is the only thing that tells them apart —
    // and being missing means the vault is never acquired, on any cycle, while its debt accrues.
    describe("when the indexer could not read every vault", () => {
      const partial = (failedVaultsCount: number) =>
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ vaults: [mockVault], total: 1, failedVaultsCount }),
        });

      it("says the escrow list is incomplete", async () => {
        const clients = createMockClients();
        const bot = createBot(clients);
        global.fetch = partial(2);

        await bot.run();

        expect(metrics.recordError).toHaveBeenCalledWith("vaults_unreadable");
      });

      // Reported, not obeyed: one unreadable vault must not cost the ones that are fine.
      it("still acts on the vaults it did get", async () => {
        const clients = createMockClients();
        const bot = createBot(clients);
        global.fetch = partial(2);

        await bot.run();

        expect(clients.sender.send).toHaveBeenCalled();
      });

      it("says nothing when the whole escrow was readable", async () => {
        const clients = createMockClients();
        const bot = createBot(clients);
        global.fetch = partial(0);

        await bot.run();

        expect(metrics.recordError).not.toHaveBeenCalledWith("vaults_unreadable");
      });

      // An indexer too old to send the field is read as "none failed" rather than blocking.
      it("tolerates an indexer that does not report the count", async () => {
        const clients = createMockClients();
        const bot = createBot(clients);
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
        });

        await bot.run();

        expect(metrics.recordError).not.toHaveBeenCalledWith("vaults_unreadable");
        expect(clients.sender.send).toHaveBeenCalled();
      });
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

  describe("batched acquisition + inventory", () => {
    /** Balance covering exactly two acquisitions at the fixture's `maxWbtcIn`. */
    const balanceFor = (n: bigint) => {
      // fixture debt 50000000n, +1% slippage => 50500000n authorised per swap
      return 50500000n * n;
    };

    /** `run()` reads balanceOf and publishes it to the gate, which is what bounds the batch. */
    const fundedWith = (clients: ReturnType<typeof createMockClients>, balance: bigint) => {
      const inner = clients.publicClient.readContract.getMockImplementation();
      clients.publicClient.readContract.mockImplementation((arg: { functionName: string }) => {
        if (arg.functionName === "balanceOf") return Promise.resolve(balance);
        return inner?.(arg);
      });
    };

    it("sends every acquisition before awaiting any receipt (batched, not serialized)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients);
      const order: string[] = [];

      clients.sender.send.mockImplementation(
        async (
          call: { nonce?: number },
          onSigned?: (tx: {
            hash: `0x${string}`;
            nonce: number;
            serialized: `0x${string}`;
          }) => Promise<void>
        ) => {
          order.push("send");
          await onSigned?.({ hash: "0xtxhash", nonce: call.nonce ?? 0, serialized: "0xraw" });
          return "0xtxhash" as `0x${string}`;
        }
      );
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) => {
          order.push("receipt");
          return Promise.resolve({ status: "success", blockNumber: 123n, transactionHash: hash });
        }
      );

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [
              mockVault,
              { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` },
              { ...mockVault, vaultId: "0xdeadbeef" as `0x${string}` },
            ],
            total: 3,
          }),
      });

      await bot.run();

      // The point of the batch: no receipt is awaited until every send has gone out. A serialized
      // loop would interleave send,receipt,send,receipt...
      expect(order.filter((o) => o === "send")).toHaveLength(3);
      expect(order.slice(0, 3)).toEqual(["send", "send", "send"]);
    });

    it("stops sending when WBTC inventory is exhausted", async () => {
      const clients = createMockClients();
      // Enough for two of the three vaults on offer.
      fundedWith(clients, balanceFor(2n));
      const bot = createBot(clients);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [
              mockVault,
              { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` },
              { ...mockVault, vaultId: "0xdeadbeef" as `0x${string}` },
            ],
            total: 3,
          }),
      });

      await bot.run();

      // Without budgeting, all three would be broadcast against the same starting balance and the
      // third would revert on-chain for insufficient funds — a self-inflicted breaker failure.
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
    });

    it("an unaffordable vault consumes neither exposure nor reservation", async () => {
      const clients = createMockClients();
      fundedWith(clients, 0n);
      const risk = createRiskGate();
      const bot = createBot(clients, { risk });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      expect(clients.sender.send).not.toHaveBeenCalled();
      // The gate blocks it, and a blocked slot reserves nothing — so an unaffordable vault leaves
      // no trace in either the exposure count or the token ledger.
      expect(risk.inFlight()).toBe(0);
      expect(risk.reserved(WBTC_ACCOUNT)).toBe(0n);
    });

    // A revert with the vault STILL in escrow normally means the chain refused what we tried to do,
    // which is our failure. An expired authorization is not that: the router rejects the batch
    // before touching anything, because it sat behind a stalled nonce longer than it was signed
    // for. A breaker of one proves the difference — a real revert would halt here.
    it("does not blame the breaker when the authorization expired before mining", async () => {
      const clients = createMockClients();
      fundedWith(clients, balanceFor(1n));
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 10n, transactionHash: hash })
      );

      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });
      const funding = (bot as unknown as { funding: { authorizationExpired: unknown } }).funding;
      funding.authorizationExpired = async () => true;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      expect(risk.state()).toBe("RUNNING");
      // Nothing moved either, so the reservation is released outright.
      expect(risk.reserved(WBTC_ACCOUNT)).toBe(0n);
    });

    // The receipt phase is where most acquisitions end, so an authorization whose identity does not
    // survive `prepareAndSend` is handed over to nothing at all — every classification would report
    // `undefined` and the batch would be held by no one. Typecheck cannot see it: the field is
    // optional, so dropping it compiles.
    it("carries the authorization's identity from the send phase into settlement", async () => {
      const clients = createMockClients();
      fundedWith(clients, balanceFor(1n));
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 10n, transactionHash: hash })
      );
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      const settled: Array<string | undefined> = [];
      const bot = createBot(clients);
      const funding = (bot as unknown as { funding: Record<string, unknown> }).funding;
      funding.buildAcquisition = async () => ({
        call: {
          address: "0xrouter",
          abi: [],
          functionName: "relay",
          args: [],
        },
        authorizationId: "0xauth",
      });
      funding.settleAuthorization = (id: string | undefined) => settled.push(id);

      await bot.run();

      expect(settled.length).toBeGreaterThan(0);
      expect(settled).not.toContain(undefined);
      expect(settled).toContain("0xauth");
    });

    // The care taken in `wasVaultTaken` — a failed read must not exempt a real failure — has to
    // survive the two reads that classify *after* it. Both of these settle through the same
    // `finally` if they throw, and that backstop used to mark the slot `abandoned`: breaker-exempt,
    // and with the spend released. A flaky endpoint could therefore silence the breaker entirely.
    describe("when a classifier read fails", () => {
      const reverted = (clients: ReturnType<typeof createMockClients>) => {
        clients.publicClient.waitForTransactionReceipt.mockImplementation(
          ({ hash }: { hash: string }) =>
            Promise.resolve({ status: "reverted", blockNumber: 10n, transactionHash: hash })
        );
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
        });
      };

      it("counts the revert against the breaker when expiry cannot be checked", async () => {
        const clients = createMockClients();
        fundedWith(clients, balanceFor(1n));
        reverted(clients);

        const risk = createRiskGate({ maxConsecutiveFailures: 1 });
        const bot = createBot(clients, { risk });
        const funding = (bot as unknown as { funding: { authorizationExpired: unknown } }).funding;
        funding.authorizationExpired = async () => {
          throw new Error("getBlock failed");
        };

        await bot.run();

        // The revert is real until something proves otherwise, and nothing did.
        expect(risk.state()).toBe("HALTED");
      });

      // The money half. The race is established, so this is still not our failure — but whether our
      // authorization paid for the vault is now unknown, and releasing the reservation on an
      // unanswered question would let the same balance be committed twice in one cycle.
      it("keeps the spend counted when the router's event cannot be read", async () => {
        const clients = createMockClients();
        fundedWith(clients, balanceFor(2n));
        reverted(clients);
        const inner = clients.publicClient.readContract.getMockImplementation();
        clients.publicClient.readContract.mockImplementation((arg: { functionName: string }) => {
          if (arg.functionName === "isVaultAcquirable") return Promise.resolve(false); // lost race
          return inner?.(arg);
        });

        const risk = createRiskGate({ maxConsecutiveFailures: 1 });
        const bot = createBot(clients, { risk });
        const funding = (bot as unknown as { funding: { spentWithoutUs: unknown } }).funding;
        funding.spentWithoutUs = async () => {
          throw new Error("getLogs failed");
        };

        await bot.run();

        // Losing a race is not a failure, however the spend question resolved.
        expect(risk.state()).toBe("RUNNING");
        // ...but the WBTC stays counted against the balance the run published, so the whole of it
        // is no longer spendable. Released instead, this slot would be admitted — which is the
        // same balance being committed twice. (No `setAvailable` here: a fresh read deliberately
        // clears what the gate had counted as spent, which would erase what is under test.)
        expect(
          risk.openSlot({
            kind: "vault-acquisition",
            subject: "0xother",
            spend: [{ ...WBTC_ACCOUNT, amount: balanceFor(2n) }],
          }).allowed
        ).toBe(false);
      });

      // A throw from somewhere no branch guards — here the escrow check itself — has to leave the
      // slot settled as what it is, a reverted acquisition, and must not cost the rest of the batch
      // its classification. Both were true of the old code only by accident: the backstop marked
      // the slot `abandoned`, and the loop had no per-item catch, so one blip hid N genuine reverts.
      it("still counts a revert whose classification threw, and classifies the rest of the batch", async () => {
        const clients = createMockClients();
        fundedWith(clients, balanceFor(2n));
        reverted(clients);

        const risk = createRiskGate({ maxConsecutiveFailures: 2 });
        const bot = createBot(clients, { risk });
        const inner = bot as unknown as { wasVaultTaken: (id: string) => Promise<boolean> };
        const original = inner.wasVaultTaken.bind(bot);
        let call = 0;
        inner.wasVaultTaken = async (id: string) => {
          call += 1;
          if (call === 1) throw new Error("escrow read exploded");
          return original(id);
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              vaults: [mockVault, { ...mockVault, vaultId: `0x${"9".repeat(64)}` }],
              total: 2,
            }),
        });

        await bot.run();

        // Two reverts, two failures: the first through the backstop, the second classified normally.
        // Either half missing leaves one failure and a running bot.
        expect(risk.state()).toBe("HALTED");

        // And the backstop keeps the unclassified one's WBTC counted: the throw came *after* a
        // receipt, so whether the money moved is exactly what we failed to establish.
        risk.resume();
        expect(
          risk.openSlot({
            kind: "vault-acquisition",
            subject: "0xother",
            spend: [{ ...WBTC_ACCOUNT, amount: balanceFor(2n) }],
          }).allowed
        ).toBe(false);
      });

      // The classification is also what the intent is stored under. Recording an expired
      // authorization as a plain "reverted" reads, months later, as the chain refusing us.
      it("persists the classification it settled on, not a generic revert", async () => {
        const clients = createMockClients();
        fundedWith(clients, balanceFor(1n));
        reverted(clients);

        const recordOutcome = vi.fn();
        const executor = {
          ...createAutoExecutorWithSender({
            nonces: passthroughNonces(),
            sender: clients.sender as unknown as AutoDeps["sender"],
            publicClient: clients.publicClient as unknown as AutoDeps["publicClient"],
            walletClient: clients.walletClient as unknown as AutoDeps["walletClient"],
            txReceiptTimeoutMs: 1000,
            logger: silentLogger,
          }),
          commit: async () => ({ kind: "broadcast", hash: "0xhash", intentId: "intent-1" }),
          recordOutcome,
        } as unknown as ArbitrageEngineConfig["executor"];

        const bot = createBot(clients, { executor });
        const funding = (bot as unknown as { funding: { authorizationExpired: unknown } }).funding;
        funding.authorizationExpired = async () => true;

        await bot.run();

        expect(recordOutcome).toHaveBeenCalledWith(
          "intent-1",
          expect.objectContaining({ kind: "failed", error: "authorization expired" })
        );
      });
    });

    // The subtler half of the same hazard: we never broadcast at all — gas estimation failed — but
    // the authorization had already left the process, and estimation is what put it in front of an
    // RPC. "We sent nothing" therefore no longer implies "our money stayed put".
    it("keeps the spend counted when an unsent acquisition was authorized and paid anyway", async () => {
      const clients = createMockClients();
      fundedWith(clients, balanceFor(1n));
      clients.publicClient.estimateContractGas.mockRejectedValue(new Error("VaultNotAcquirable"));
      const inner = clients.publicClient.readContract.getMockImplementation();
      clients.publicClient.readContract.mockImplementation((arg: { functionName: string }) => {
        if (arg.functionName === "isVaultAcquirable") return Promise.resolve(false);
        return inner?.(arg);
      });

      const risk = createRiskGate();
      const bot = createBot(clients, { risk });
      const funding = (bot as unknown as { funding: { spentWithoutUs: unknown } }).funding;
      funding.spentWithoutUs = async () => true;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      expect(risk.reserved(WBTC_ACCOUNT)).toBe(0n);
      expect(
        risk.openSlot({
          kind: "vault-acquisition",
          subject: "0xnext",
          spend: [{ ...WBTC_ACCOUNT, amount: balanceFor(1n) }],
        }).allowed
      ).toBe(false);
    });

    // Under router funding the payment is authorized separately from the transaction and outlives
    // it, so another send of the same signed batch can execute first. Our transaction then reverts
    // on a vault that is already gone, which looks exactly like a lost race, except the treasury's
    // WBTC left under our own signature. Releasing the reservation would hand the same balance out
    // twice in one cycle.
    it("keeps the spend counted when our own authorization acquired the vault", async () => {
      const clients = createMockClients();
      fundedWith(clients, balanceFor(1n));
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 10n, transactionHash: hash })
      );
      // The vault is gone by the time we classify — from the receipt alone, an ordinary lost race.
      const inner = clients.publicClient.readContract.getMockImplementation();
      clients.publicClient.readContract.mockImplementation((arg: { functionName: string }) => {
        if (arg.functionName === "isVaultAcquirable") return Promise.resolve(false);
        return inner?.(arg);
      });

      const risk = createRiskGate();
      const bot = createBot(clients, { risk });
      // Stand in for router funding: the one thing that differs is whether a lost race can still
      // have spent our money.
      const funding = (bot as unknown as { funding: { spentWithoutUs: unknown } }).funding;
      funding.spentWithoutUs = async () => true;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      // Reservation released, but the outflow stays counted against the balance until a refresh —
      // so the very next acquisition of the same size no longer fits.
      expect(risk.reserved(WBTC_ACCOUNT)).toBe(0n);
      expect(
        risk.openSlot({
          kind: "vault-acquisition",
          subject: "0xnext",
          spend: [{ ...WBTC_ACCOUNT, amount: balanceFor(1n) }],
        }).allowed
      ).toBe(false);
    });

    it("frees the reservation for a competitor-won vault so the next one can use it", async () => {
      const clients = createMockClients();
      fundedWith(clients, balanceFor(1n)); // room for exactly one acquisition at a time
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 1n, transactionHash: hash })
      );
      const risk = createRiskGate();
      const bot = createBot(clients, { risk });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ vaults: [mockVault], total: 1 }),
      });

      await bot.run();

      // A revert transfers nothing, so holding its WBTC would strand capacity the signer still has.
      expect(risk.reserved(WBTC_ACCOUNT)).toBe(0n);
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
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 1n, transactionHash: hash })
      );
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });

      await bot.acquireVault(mockVault); // reverts → slot settles !ok → breaker trips
      expect(risk.state()).toBe("HALTED");
    });

    it("does NOT trip the breaker when the revert is a lost race (vault no longer acquirable)", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockImplementation(
        ({ hash }: { hash: string }) =>
          Promise.resolve({ status: "reverted", blockNumber: 1n, transactionHash: hash })
      );
      // The swap reverted because another arbitrageur already acquired the vault: it has left escrow.
      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          // The batch path budgets acquisitions against real WBTC inventory, so a
          // zero balance now (correctly) blocks every send. Fund the fixture.
          if (functionName === "balanceOf") return Promise.resolve(10n ** 18n);
          if (functionName === "isVaultAcquirable") return Promise.resolve(false); // taken
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
          if (functionName === "allowance") return Promise.resolve(BigInt("1000000000000"));
          return Promise.resolve(0n);
        }
      );
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });

      await bot.acquireVault(mockVault); // reverts, but lost race → contended → breaker untouched
      expect(risk.state()).toBe("RUNNING");
    });

    it("does NOT trip the breaker when the receipt never arrives (outcome unknown)", async () => {
      const clients = createMockClients();
      // The tx may still be in the mempool — behind a nonce gap it certainly is — so this is an
      // unknown outcome, not evidence the chain rejected us.
      clients.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("boom"));
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });

      await bot.acquireVault(mockVault);

      expect(risk.state()).toBe("RUNNING");
    });

    it("releases the exposure slot when the receipt lookup throws (no leak)", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("boom"));
      // One slot total: if the failed acquisition leaked it, the next openSlot is refused and the
      // engine would wedge at zero capacity forever.
      const risk = createRiskGate({ maxInFlight: 1 });
      const bot = createBot(clients, { risk });

      await bot.acquireVault(mockVault);

      expect(risk.openSlot({ kind: "vault-acquisition", subject: "0xnext" }).allowed).toBe(true);
    });

    it("does NOT trip the breaker when a whole batch times out", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
      // A shared cause (one burned nonce strands everything behind it) times out the entire batch
      // at once. Counting those as failures is what halted a healthy bot in the N=40 stress run.
      const risk = createRiskGate({ maxConsecutiveFailures: 3 });
      const bot = createBot(clients, { risk });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [
              mockVault,
              { ...mockVault, vaultId: "0xaabbccdd" as `0x${string}` },
              { ...mockVault, vaultId: "0xdeadbeef" as `0x${string}` },
              { ...mockVault, vaultId: "0xfeedface" as `0x${string}` },
            ],
            total: 4,
          }),
      });

      await bot.run();

      expect(risk.state()).toBe("RUNNING");
    });

    // The floor bounds the WORST case the tx authorizes, not the optimistic preview:
    // amountVault 100_000_000 − maxWbtcIn (amountWbtcToAcquire 50_000_000 + 1% slippage
    // = 50_500_000) ⇒ expectedProfit = 49_500_000 sats.
    const EXPECTED_PROFIT = 49_500_000n;

    it("blocks a vault below the profit floor (minProfit) — no tx", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ minProfit: EXPECTED_PROFIT + 1n });
      const bot = createBot(clients, { risk });

      const result = await bot.acquireVault(mockVault);

      expect(result).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    });

    it("allows a vault at the profit floor (positive control)", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ minProfit: EXPECTED_PROFIT });
      const bot = createBot(clients, { risk });

      expect(await bot.acquireVault(mockVault)).toBe("acquired");
      expect(clients.sender.send).toHaveBeenCalledOnce();
    });

    // Regression: the floor must bound the worst case the tx authorizes. `swapWbtcForVault`
    // charges the debt+fee prevailing at execution and only reverts above `maxWbtcIn`, so a
    // vault whose *optimistic* (preview) profit clears the floor can still realize less after
    // interest accrual. Flooring on the un-slipped preview cost would wrongly allow this.
    it("floors on the slippage-adjusted worst case, not the optimistic preview", async () => {
      const clients = createMockClients();
      const OPTIMISTIC_PROFIT = 50_000_000n; // amountVault − amountWbtcToAcquire (no slippage)
      const risk = createRiskGate({ minProfit: OPTIMISTIC_PROFIT });
      const bot = createBot(clients, { risk });

      expect(await bot.acquireVault(mockVault)).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    });

    it("blocks a vault whose source data is stale (maxDataStalenessMs) — no tx", async () => {
      const NOW = 1_000_000_000;
      const clients = createMockClients();
      const risk = createRiskGate({ maxDataStalenessMs: 60_000, now: () => NOW });
      const bot = createBot(clients, { risk });

      const result = await bot.acquireVault(mockVault, NOW - 120_000); // 2 min old

      expect(result).toBe("skipped");
      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    });

    it("allows a vault whose source data is fresh (positive control)", async () => {
      const NOW = 1_000_000_000;
      const clients = createMockClients();
      const risk = createRiskGate({ maxDataStalenessMs: 60_000, now: () => NOW });
      const bot = createBot(clients, { risk });

      expect(await bot.acquireVault(mockVault, NOW - 5_000)).toBe("acquired");
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

    // The wedge this guards against, seen for real in the N=40 stress run: the liquidation engine
    // (sharing this nonce allocator) burned a nonce, so every acquisition broadcast behind it sat
    // in the mempool `queued` and no receipt ever came. Counting those as failures halted the gate,
    // and `run()` returns early when HALTED — BEFORE reconcile + resync — so the very machinery that
    // reclaims the gap could never run again. The batch was stuck permanently.
    it("is not wedged when a whole batch's receipts go unresolved (next cycle still recovers)", async () => {
      const store = createMemoryStateStore();
      const clients = createMockClients();
      (clients.walletClient as { chain?: { id: number } }).chain = { id: 31337 };
      (clients.publicClient as { getTransactionCount?: unknown }).getTransactionCount = vi
        .fn()
        .mockResolvedValue(5);
      // Every acquisition is stranded behind a nonce gap: broadcast, but no receipt, ever.
      clients.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("stranded"));
      // How a stranded tx actually looks to the node, and what reconcile reads: KNOWN (it is sitting
      // in the mempool) but NOT MINED. `getReceiptStatus` maps only TransactionReceiptNotFoundError
      // to "not mined"; any other error propagates by design, so the type matters here.
      (clients.publicClient as Record<string, unknown>).getTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new TransactionReceiptNotFoundError({ hash: "0xtxhash" }));
      (clients.publicClient as Record<string, unknown>).getTransaction = vi
        .fn()
        .mockResolvedValue({ hash: "0xtxhash", nonce: 5 });
      const nonces = createNonceAllocator(createNonceLease(), "0xarbitrageur");
      const resyncSpy = vi.spyOn(nonces, "resync");
      // Low enough that treating the stranded batch as failures would trip it.
      const risk = createRiskGate({ maxConsecutiveFailures: 2 });
      const bot = createBot(clients, { store, nonces, risk });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            vaults: [
              mockVault,
              { ...mockVault, vaultId: `0x${"c".repeat(64)}` },
              { ...mockVault, vaultId: `0x${"d".repeat(64)}` },
            ],
          }),
      }) as unknown as typeof fetch;

      await bot.run();
      expect(risk.state()).toBe("RUNNING");

      const resyncsAfterFirstCycle = resyncSpy.mock.calls.length;
      await bot.run();

      // Reaching resync again is what makes recovery possible: it re-seeds the lease from the chain,
      // so the next send fills the gap and everything queued behind it becomes executable.
      expect(resyncSpy.mock.calls.length).toBeGreaterThan(resyncsAfterFirstCycle);
    });
  });

  // Viem answers a receipt lookup with whatever took the transaction's nonce, so a receipt is only
  // ours when its hash is. Everything downstream reads a successful one as proof the acquisition
  // happened: the intent is confirmed, the vault counted, and — under router funding — the signed
  // batch retired as consumed while it is still executable until its deadline.
  describe("a receipt for a replacement transaction", () => {
    const replaced = (clients: ReturnType<typeof createMockClients>) => {
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 123n,
        transactionHash: "0xsomeoneelse",
      });
    };

    it("is not counted as an acquisition", async () => {
      const clients = createMockClients();
      replaced(clients);
      const bot = createBot(clients);

      expect(await bot.acquireVault(mockVault)).toBe("skipped");
      expect(metrics.recordVaultAcquired).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("tx_replaced");
    });

    // The batch a replacement did not carry is still signed, still unexpired, and still able to
    // spend the treasury. Reporting it as consumed is what deletes the only record holding it.
    it("does not report the authorization as consumed", async () => {
      const clients = createMockClients();
      replaced(clients);
      const bot = createBot(clients);
      const settleAuthorization = vi.fn();
      (
        bot as unknown as { funding: { settleAuthorization: unknown } }
      ).funding.settleAuthorization = settleAuthorization;

      await bot.acquireVault(mockVault);

      expect(settleAuthorization).toHaveBeenCalled();
      for (const [, outcome] of settleAuthorization.mock.calls) {
        expect(outcome).toMatchObject({ consumed: false });
      }
    });

    it("records the intent as replaced rather than confirmed", async () => {
      const clients = createMockClients();
      replaced(clients);
      const recordOutcome = vi.fn();
      const executor = {
        ...createAutoExecutorWithSender({
          nonces: passthroughNonces(),
          sender: clients.sender as unknown as AutoDeps["sender"],
          publicClient: clients.publicClient as unknown as AutoDeps["publicClient"],
          walletClient: clients.walletClient as unknown as AutoDeps["walletClient"],
          txReceiptTimeoutMs: 1000,
          logger: silentLogger,
        }),
        commit: async () => ({ kind: "broadcast", hash: "0xtxhash", intentId: "intent-1" }),
        recordOutcome,
      } as unknown as ArbitrageEngineConfig["executor"];

      await createBot(clients, { executor }).acquireVault(mockVault);

      expect(recordOutcome).toHaveBeenCalledWith(
        "intent-1",
        expect.objectContaining({ kind: "failed", error: "replaced by 0xsomeoneelse" })
      );
    });
  });
});

// A real `RouterFunding`, because the hazard is in the hand-off between the gate and the mode's own
// ledger: the treasury's capacity is published once per cycle, before the send loop, while the loop
// signs batches and abandons them as it goes. A stub with an overridden `spentWithoutUs` cannot show
// that — it has no ledger to leave stale.
describe("ArbitrageEngine + router funding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics = createMetrics();
  });

  const SIGNER = "0x1111111111111111111111111111111111111111" as const;
  const PAYER = "0x2222222222222222222222222222222222222222" as const;
  const WBTC = "0x3333333333333333333333333333333333333333" as const;
  const ROUTER = "0x4444444444444444444444444444444444444444" as const;
  const VAULT_SWAP = "0x5555555555555555555555555555555555555555" as const;
  const KEEPER = "0x6666666666666666666666666666666666666666" as const;

  /** Exactly one acquisition's worth: 0.5 WBTC of cost plus the 1% slippage ceiling. */
  const CAPACITY = 50_500_000n;

  function routerClients(capacity = CAPACITY) {
    const signTypedData = vi.fn().mockResolvedValue("0xsig");
    const immutables: Record<string, unknown> = { signer: SIGNER, payer: PAYER, wbtc: WBTC };
    const publicClient = {
      readContract: vi.fn(
        ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
          if (functionName in immutables) return Promise.resolve(immutables[functionName]);
          if (functionName === "WBTC") return Promise.resolve(WBTC);
          if (functionName === "balanceOf" || functionName === "allowance") {
            return Promise.resolve(capacity);
          }
          if (functionName === "isVaultAcquirable") return Promise.resolve(true);
          if (functionName === "previewEscrowedVaults") {
            return Promise.resolve(
              (args?.[0] as readonly `0x${string}`[]).map((vaultId) => ({
                vaultId,
                amountVault: 100_000_000n,
                amountDebt: 50_000_000n,
                amountInterest: 0n,
                amountFee: 0n,
                amountWbtcEquivalent: 100_000_000n,
                amountWbtcToAcquire: 50_000_000n,
                amountProfitEst: 50_000_000n,
              }))
            );
          }
          return Promise.resolve(0n);
        }
      ),
      getBlock: vi
        .fn()
        .mockResolvedValue({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([]),
      estimateContractGas: vi.fn().mockResolvedValue(100_000n),
      waitForTransactionReceipt: vi
        .fn()
        .mockImplementation(({ hash }: { hash: string }) =>
          Promise.resolve({ status: "success", blockNumber: 101n, transactionHash: hash })
        ),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", blockNumber: 101n }),
    };
    return {
      signTypedData,
      publicClient,
      sender: mockSender({ from: SIGNER, chainId: 31337 }),
      walletClient: {
        account: { address: SIGNER, signTypedData },
        chain: { id: 31337 },
        writeContract: vi.fn().mockResolvedValue("0xtxhash"),
      },
    };
  }

  function routerBot(clients: ReturnType<typeof routerClients>, risk = createRiskGate()) {
    return new ArbitrageEngine({
      publicClient: clients.publicClient as unknown as ArbitrageEngineConfig["publicClient"],
      vaultSwapAddress: VAULT_SWAP,
      wbtcAddress: WBTC,
      vaultKeeperAddress: KEEPER,
      funding: { mode: "router", routerAddress: ROUTER, deadlineSeconds: 120 },
      indexer: INDEXER_STUB,
      maxSlippageBps: 100,
      vaultProcessingDelayMs: 0,
      txReceiptTimeoutMs: 1000,
      metrics,
      logger: silentLogger,
      risk,
      executor: createAutoExecutorWithSender({
        nonces: passthroughNonces(),
        sender: clients.sender as unknown as AutoDeps["sender"],
        publicClient: clients.publicClient as unknown as AutoDeps["publicClient"],
        walletClient: clients.walletClient as unknown as AutoDeps["walletClient"],
        txReceiptTimeoutMs: 1000,
        logger: silentLogger,
      }),
    });
  }

  const twoVaults = () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          vaults: [
            { ...mockVault, vaultId: `0x${"a".repeat(64)}` },
            { ...mockVault, vaultId: `0x${"b".repeat(64)}` },
          ],
        }),
    }) as unknown as typeof fetch;
  };

  // The exit the report is about. The batch for the first vault is signed — gas estimation is what
  // puts it in front of an RPC — and then the estimate reverts on a vault that is still acquirable,
  // so the acquisition is abandoned. Its treasury WBTC is no longer reserved by the gate, and the
  // batch can still be executed until its deadline: the second vault must not be admitted against
  // the same money just because no refresh has run since.
  it("does not fund a second vault against WBTC a signed batch can still take", async () => {
    const clients = routerClients();
    clients.publicClient.estimateContractGas.mockRejectedValue(new Error("insufficient profit"));
    const bot = routerBot(clients);
    await bot.prepare();
    twoVaults();

    await bot.run();

    expect(clients.signTypedData).toHaveBeenCalledTimes(1);
    expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    expect(clients.sender.send).not.toHaveBeenCalled();
  });

  // A throw between the broadcast and the classification — here a malformed indexer row, whose
  // `BigInt` conversion happens before `prepareAndSend` can guard it — leaves the batch broadcast
  // and its slot unsettled. The cycle's own backstop settles such a slot through the gate alone,
  // which releases the reservation and tells the funding mode nothing: the treasury's WBTC would
  // read as spendable while a signed batch could still take it.
  it("hands a live batch over when the cycle throws after broadcasting it", async () => {
    const clients = routerClients(CAPACITY * 2n);
    const bot = routerBot(clients);
    await bot.prepare();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          vaults: [
            { ...mockVault, vaultId: `0x${"a".repeat(64)}` },
            { ...mockVault, vaultId: `0x${"b".repeat(64)}`, btcAmount: "not-a-number" },
          ],
        }),
    }) as unknown as typeof fetch;

    await bot.run();

    expect(metrics.recordError).toHaveBeenCalledWith("poll_error");
    expect(metrics.recordFundingCapacity.mock.calls.at(-1)?.[0]).toMatchObject({
      authorized: CAPACITY,
    });
  });

  // Positive control for the same fixture: with capacity for two, the second vault is funded.
  // Without it the test above would pass on a bot that simply never acquires anything.
  it("funds a second vault when the treasury can cover both", async () => {
    const clients = routerClients(CAPACITY * 2n);
    clients.publicClient.estimateContractGas.mockRejectedValue(new Error("insufficient profit"));
    const bot = routerBot(clients);
    await bot.prepare();
    twoVaults();

    await bot.run();

    expect(clients.signTypedData).toHaveBeenCalledTimes(2);
  });
});
