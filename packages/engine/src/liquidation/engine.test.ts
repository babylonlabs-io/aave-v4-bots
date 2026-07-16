import {
  type NonceAllocator,
  PreBroadcastError,
  createNonceAllocator,
  createNonceLease,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { NotificationEvent, Notifier } from "@repo/notifications";
import { type MemoryStateStore, type StateStore, createMemoryStateStore } from "@repo/persistence";
import { createRiskGate } from "@repo/risk";
import { type PublicClient, TransactionReceiptNotFoundError, maxUint256 } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoExecutorFromWallet, createManualExecutor } from "../executor";
import { LiquidationEngine, type LiquidationEngineConfig } from "./engine";
import type { LiquidatablePosition } from "./types";

// Stub metrics port — the engine reports through it; tests assert on it directly.
// Recreated per test so call counts don't leak between cases.
function createMetrics() {
  return {
    recordPositionsChecked: vi.fn(),
    recordPositionsLiquidatable: vi.fn(),
    recordLiquidationSuccess: vi.fn(),
    recordLiquidationFailed: vi.fn(),
    recordSimulationFailed: vi.fn(),
    recordError: vi.fn(),
    recordPollDuration: vi.fn(),
    recordTokenBalance: vi.fn(),
  };
}
const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let metrics: ReturnType<typeof createMetrics>;

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

const mockAmounts = [1000000n] as const;

const mockPosition: LiquidatablePosition = {
  proxyAddress: "0x1234567890123456789012345678901234567890",
  borrower: "0xborrower0000000000000000000000000000000001",
  amounts: ["1000000"],
  vaults: ["0xvault1"],
  suppliedShares: "1000000000",
};

/**
 * A `TxSender` that skips real signing but honors the contract that matters: `onSigned` (the
 * durable nonce + hash record) runs BEFORE the broadcast resolves, so crash-safety tests
 * exercise the same ordering as the real sender. Carries an `identity` like a real sender — the
 * engine reads `sender.identity` for the intent's chain id and the simulation `from`.
 */
function mockSender(identity = { from: "0xliquidator" as `0x${string}`, chainId: 31337 }) {
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
      account: { address: "0xliquidator" as `0x${string}` },
      // A real `WalletClient<Transport, Chain, Account>` always has a chain; the engine reads
      // `chain.id` for the intent's idempotency key.
      chain: { id: 31337 },
      writeContract: vi.fn().mockResolvedValue("0xtxhash"), // approvals only
    },
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({ result: true }),
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "estimateLiquidation") {
          // [amounts, wbtcPayment, vaults] — wbtcPayment is the WBTC the
          // adapter pulls from msg.sender for fairness + redemption fee.
          return Promise.resolve([mockAmounts, 0n, ["0xvault1"]]);
        }
        return Promise.resolve(BigInt("1000000000000000000"));
      }),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      // Reconcile asks for receipts. The default answer is viem's "not mined yet" signal — a
      // *typed* error, not a bare throw: `getReceiptStatus` only reads this one as "no receipt",
      // and propagates anything else (an RPC outage must never look like "not mined").
      getTransactionReceipt: vi
        .fn()
        .mockRejectedValue(new TransactionReceiptNotFoundError({ hash: "0xtxhash" })),
      // Reconcile also asks whether the node knows the tx at all: here it was broadcast, so
      // it does (in flight). Returning "unknown" would read as a rejected broadcast.
      getTransaction: vi.fn().mockResolvedValue({ hash: "0xtxhash" }),
      waitForTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "success", blockNumber: 123n, logs: [] }),
    },
  };
}

/**
 * A pre-seeded pass-through allocator: hands out nonce 0 and treats `resync` as a no-op. For tests
 * that drive a send path directly (e.g. `ensureApproval`) without a `run()` to seed the lease from
 * the chain; `run()`-based tests keep the default real allocator, seeded from `getTransactionCount`.
 */
const passthroughNonces = (): NonceAllocator => ({
  withNonce: (send) => send(0),
  resync: async () => {},
});

type AutoDeps = Parameters<typeof createAutoExecutorFromWallet>[0];

/**
 * Build the engine with a default AUTO executor over the mock wallet + sender (the composition the
 * `@repo/runtime` root does in production), unless a test injects its own `executor` (e.g. a keyless
 * `ManualExecutor`). `store`/`nonces` steer the executor's crash-safety + nonce plumbing.
 */
function createBot(
  clients: ReturnType<typeof createMockClients>,
  overrides: Partial<LiquidationEngineConfig> & {
    store?: StateStore;
    nonces?: NonceAllocator;
  } = {}
): LiquidationEngine {
  const { store, nonces, executor, ...engineOverrides } = overrides;
  return new LiquidationEngine({
    publicClient: clients.publicClient as unknown as LiquidationEngineConfig["publicClient"],
    adapterAddress: "0xadapter" as `0x${string}`,
    lensAddress: "0xlens" as `0x${string}`,
    wbtcAddress: "0xwbtc" as `0x${string}`,
    btcRedeemKey: ZERO_BYTES32,
    isDirectRedemption: false,
    llpAddress: "0xllpaddress000000000000000000000000000000" as `0x${string}`,
    ponderUrl: "http://localhost:42069",
    txReceiptTimeoutMs: 60000,
    metrics,
    logger: silentLogger,
    risk: createRiskGate(), // permissive by default
    executor:
      executor ??
      createAutoExecutorFromWallet({
        store,
        nonces,
        sender: clients.sender as unknown as AutoDeps["sender"],
        publicClient: clients.publicClient as unknown as AutoDeps["publicClient"],
        walletClient: clients.walletClient as unknown as AutoDeps["walletClient"],
        txReceiptTimeoutMs: 60000,
        logger: silentLogger,
      }),
    ...engineOverrides,
  });
}

describe("LiquidationEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics = createMetrics();
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
      expect(clients.sender.send).toHaveBeenCalledOnce();
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
      expect(clients.sender.send).not.toHaveBeenCalled();
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

  describe("run() - risk gate", () => {
    const liquidatable = () => ({
      ok: true,
      json: () => Promise.resolve({ liquidatable: [mockPosition], total: 1, checked: 1 }),
    });

    it("skips the whole cycle when the gate is HALTED (kill-switch)", async () => {
      const clients = createMockClients();
      const risk = createRiskGate();
      risk.halt("manual");
      const bot = createBot(clients, { risk });
      global.fetch = vi.fn().mockResolvedValue(liquidatable());

      await bot.run();

      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("trips the breaker on a reverted liquidation, halting subsequent runs", async () => {
      const clients = createMockClients();
      clients.publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 1n,
        logs: [],
      });
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });
      global.fetch = vi.fn().mockResolvedValue(liquidatable());

      await bot.run(); // sends 1 tx → reverts → slot settles !ok → breaker trips
      expect(risk.state()).toBe("HALTED");

      clients.publicClient.simulateContract.mockClear();
      await bot.run(); // now HALTED → short-circuits before simulate
      expect(clients.publicClient.simulateContract).not.toHaveBeenCalled();
    });

    // The breaker exists to stop us when THE CHAIN is rejecting our txs. A failure to prepare,
    // sign, or durably record never reaches the chain, so it must settle as `abandoned` and
    // leave the breaker alone — otherwise a database or RPC blip halts a healthy bot.
    it("does NOT trip the breaker when the send fails before broadcasting", async () => {
      const clients = createMockClients();
      clients.sender.send = vi
        .fn()
        .mockRejectedValue(new PreBroadcastError(new Error("store unavailable")));
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });
      global.fetch = vi.fn().mockResolvedValue(liquidatable());

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalled(); // we really did attempt the send
      expect(risk.state()).not.toBe("HALTED");
      expect(risk.inFlight()).toBe(0); // and the exposure slot was still released
    });

    // The counterpart: an ambiguous *broadcast* failure may be on chain, so it IS a real
    // failure signal and must feed the breaker.
    it("trips the breaker when the broadcast itself fails (ambiguous)", async () => {
      const clients = createMockClients();
      clients.sender.send = vi.fn().mockRejectedValue(new Error("rpc timeout"));
      const risk = createRiskGate({ maxConsecutiveFailures: 1 });
      const bot = createBot(clients, { risk });
      global.fetch = vi.fn().mockResolvedValue(liquidatable());

      await bot.run();

      expect(risk.state()).toBe("HALTED");
    });

    const NOW = 1_000_000_000;
    const feedAt = (dataTimestampMs?: number) =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ liquidatable: [mockPosition], total: 1, checked: 1, dataTimestampMs }),
      });

    it("blocks a stale candidate (maxDataStalenessMs) — no tx", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ maxDataStalenessMs: 60_000, now: () => NOW });
      const bot = createBot(clients, { risk });
      global.fetch = feedAt(NOW - 120_000); // indexer's reads are 2 min old

      await bot.run();

      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    });

    it("allows a fresh candidate (positive control)", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ maxDataStalenessMs: 60_000, now: () => NOW });
      const bot = createBot(clients, { risk });
      global.fetch = feedAt(NOW - 5_000);

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledOnce();
    });

    // Fail-closed: an operator who opts into a staleness bound must not silently trade on data
    // of unknown age (old indexer, or its block-timestamp probe failed).
    it("blocks when the freshness guard is configured but the indexer reports no timestamp", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ maxDataStalenessMs: 60_000, now: () => NOW });
      const bot = createBot(clients, { risk });
      global.fetch = feedAt(undefined); // older indexer / failed probe

      await bot.run();

      expect(clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("risk_blocked");
    });

    it("ignores a missing timestamp when the freshness guard is not configured (default)", async () => {
      const clients = createMockClients();
      const bot = createBot(clients, { risk: createRiskGate() }); // permissive default
      global.fetch = feedAt(undefined);

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledOnce();
    });

    // Documents a known gap: liquidation profit is not derivable off-chain today (the Lens
    // estimate and the tx return value carry no WBTC-denominated profit), so the engine passes
    // no `expectedProfit` and the floor cannot bite here. If someone later wires a profit value,
    // this test fails loudly — which is the point.
    it("does NOT apply the profit floor to liquidations (expectedProfit not derivable)", async () => {
      const clients = createMockClients();
      const risk = createRiskGate({ minProfit: 10n ** 30n }); // absurd floor
      const bot = createBot(clients, { risk });
      global.fetch = feedAt(NOW);

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledOnce();
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
      expect(clients.sender.send).not.toHaveBeenCalled();
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
      expect(clients.sender.send).not.toHaveBeenCalled();
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
      expect(clients.sender.send).toHaveBeenCalledTimes(1);
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

      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: 42,
          functionName: "liquidateWithLLP",
        }),
        expect.any(Function)
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

      // Bot adds 1% buffer to Lens-returned amounts to cover interest accrual
      const bufferedAmounts = mockAmounts.map((amt) => (amt * 10100n) / 10000n);
      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: 7,
          functionName: "liquidate",
          // minVaultBtcOut=0n disables BTC-out slippage protection; numVaultsToLiquidate=
          // maxUint256 is the sentinel for "unbounded prefix" (the new params from the
          // bumped adapter).
          args: [mockPosition.borrower, nonZeroRedeemKey, bufferedAmounts, [0n], 0n, maxUint256],
        }),
        expect.any(Function)
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

      expect(clients.sender.send).toHaveBeenCalledTimes(2);
      expect(clients.sender.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ nonce: 10 }),
        expect.any(Function)
      );
      expect(clients.sender.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ nonce: 11 }),
        expect.any(Function)
      );
    });

    it("stops the cycle after a send error (does not process later positions)", async () => {
      const clients = createMockClients();

      const position2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        borrower: "0xborrower0000000000000000000000000000000002",
      };

      // The first send throws — an AMBIGUOUS broadcast (the tx may be on the wire). The loop must
      // break rather than reserve the next nonce for position 2: continuing could leave a gap that
      // wedges every later tx, or double-act if position 1 actually landed. The next cycle's
      // reconcile + resync resolves the in-flight intent by nonce vs. chain.
      clients.sender.send.mockRejectedValueOnce(new Error("nonce too low"));

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

      // Only the first position was attempted; the cycle stopped before position 2.
      expect(clients.sender.send).toHaveBeenCalledTimes(1);
      // Nothing was successfully sent, so no receipt is awaited.
      expect(clients.publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it("records failed liquidation when receipt shows reverted", async () => {
      const clients = createMockClients();

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

      expect(metrics.recordLiquidationFailed).toHaveBeenCalled();
    });

    it("records successful liquidation when receipt confirms", async () => {
      const clients = createMockClients();

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

      expect(metrics.recordLiquidationSuccess).toHaveBeenCalled();
    });
  });

  describe("ensureApproval()", () => {
    it("approves when allowance is below threshold", async () => {
      const clients = createMockClients();
      // Return low allowance
      clients.publicClient.readContract.mockResolvedValue(0n);

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
        nonces: passthroughNonces(),
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

    it("still approves WBTC when no debt tokens configured", async () => {
      const clients = createMockClients();
      // 0n allowance forces approval path; symbol/decimals reads happen during
      // logging via getTokenMeta. The single readContract spy covers all three.
      clients.publicClient.readContract.mockImplementation(
        ({ functionName }: { functionName: string }) => {
          if (functionName === "allowance") return Promise.resolve(0n);
          if (functionName === "symbol") return Promise.resolve("WBTC");
          if (functionName === "decimals") return Promise.resolve(8);
          return Promise.resolve(0n);
        }
      );
      const bot = createBot(clients, { debtTokenAddresses: [], nonces: passthroughNonces() });

      // WBTC approval is unconditional — the adapter pulls WBTC from msg.sender
      // for fairness + direct-redemption fee, independent of whether WBTC is a
      // borrowable debt token on the Spoke.
      await bot.ensureApproval();

      expect(clients.walletClient.writeContract).toHaveBeenCalledTimes(1);
      expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "0xwbtc",
          functionName: "approve",
        })
      );
    });
  });

  describe("discoverDebtTokens()", () => {
    it("discovers borrowable reserves from Spoke", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract.mockImplementation(
        ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
          if (functionName === "BTC_VAULT_CORE_SPOKE") return Promise.resolve("0xspoke");
          if (functionName === "getReserveCount") return Promise.resolve(2n);
          if (functionName === "getReserve") {
            const idx = (args?.[0] as bigint) ?? 0n;
            if (idx === 0n) return Promise.resolve({ flags: 0x04, underlying: "0xtoken1" });
            return Promise.resolve({ flags: 0x00, underlying: "0xtoken2" });
          }
          if (functionName === "symbol") return Promise.resolve("USDC");
          if (functionName === "decimals") return Promise.resolve(6);
          return Promise.resolve(0n);
        }
      );

      const bot = createBot(clients);

      await bot.discoverDebtTokens();

      // BTC_VAULT_CORE_SPOKE + getReserveCount + 2× getReserve + symbol + decimals
      // (decimals is read alongside symbol via getTokenMeta cache).
      expect(clients.publicClient.readContract).toHaveBeenCalledTimes(6);
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

      clients.publicClient.readContract.mockImplementation(
        ({ functionName, address }: { functionName: string; address: string }) => {
          if (functionName === "symbol")
            return Promise.resolve(address === "0xwbtc" ? "WBTC" : "USDC");
          if (functionName === "decimals") return Promise.resolve(address === "0xwbtc" ? 8 : 6);
          if (functionName === "balanceOf")
            return Promise.resolve(address === "0xwbtc" ? 50000000n : 1000000n);
          return Promise.resolve(0n);
        }
      );

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await expect(bot.logBalances()).resolves.not.toThrow();
      expect(metrics.recordTokenBalance).toHaveBeenCalled();
    });

    it("swallows a balance-read failure so the poll loop keeps running", async () => {
      const clients = createMockClients();
      clients.publicClient.readContract.mockRejectedValue(new Error("RPC blip"));
      const bot = createBot(clients, { debtTokenAddresses: ["0xtoken1" as `0x${string}`] });

      // Must not throw — a transient RPC error during balance logging must not
      // escape to the poll loop and crash the process.
      await expect(bot.logBalances()).resolves.not.toThrow();
    });

    it("caches symbol and decimals across calls (steady-state RPC reduction)", async () => {
      const clients = createMockClients();

      clients.publicClient.readContract.mockImplementation(
        ({ functionName, address }: { functionName: string; address: string }) => {
          if (functionName === "symbol")
            return Promise.resolve(address === "0xwbtc" ? "WBTC" : "USDC");
          if (functionName === "decimals") return Promise.resolve(address === "0xwbtc" ? 8 : 6);
          if (functionName === "balanceOf")
            return Promise.resolve(address === "0xwbtc" ? 50000000n : 1000000n);
          return Promise.resolve(0n);
        }
      );

      const bot = createBot(clients, {
        debtTokenAddresses: ["0xtoken1" as `0x${string}`],
      });

      await bot.logBalances();
      const callsAfterFirst = clients.publicClient.readContract.mock.calls.length;

      await bot.logBalances();
      const callsAfterSecond = clients.publicClient.readContract.mock.calls.length;

      // Second cycle should only re-read balanceOf for each token (1 debt + 1 WBTC = 2),
      // not symbol/decimals (cached).
      expect(callsAfterSecond - callsAfterFirst).toBe(2);
    });
  });

  describe("crash-safety (StateStore)", () => {
    const feed = (positions: LiquidatablePosition[]) =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ liquidatable: positions, total: 1, checked: 1 }),
      });

    // A bot wired with the store + a fresh in-memory nonce allocator (as the composition root
    // does). A new allocator per bot models a restart (in-memory lease resets; the store
    // persists). The allocator is seeded from the chain by run()'s cycle-start resync.
    function storeBot(store: MemoryStateStore) {
      const clients = createMockClients();
      // The store path reads chainId off the wallet's chain.
      (clients.walletClient as { chain?: { id: number } }).chain = { id: 31337 };
      const nonces = createNonceAllocator(createNonceLease(), clients.walletClient.account.address);
      const bot = createBot(clients, { store, nonces });
      return { bot, clients };
    }

    it("re-drives after a crash mid-submit without double-sending", async () => {
      const store = createMemoryStateStore();

      // Run 1: the tx is broadcast, but the receipt never lands (simulated crash before
      // confirmation), so the intent is left 'submitted' (in-flight).
      const first = storeBot(store);
      first.clients.publicClient.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("process killed"));
      global.fetch = feed([mockPosition]);
      await first.bot.run();

      expect(first.clients.sender.send).toHaveBeenCalledOnce();
      const inflight = await store.reconcile();
      expect(inflight).toHaveLength(1);
      expect(inflight[0].status).toBe("submitted");

      // Restart: a fresh engine over the same store reconciles (receipt still not found →
      // left in-flight), then re-drives the same position — which is refused as a duplicate.
      const second = storeBot(store);
      await second.bot.reconcile();
      global.fetch = feed([mockPosition]);
      await second.bot.run();

      expect(second.clients.sender.send).not.toHaveBeenCalled();
      expect(metrics.recordError).toHaveBeenCalledWith("intent_in_flight");
    });

    it("keeps a failed send live, then re-drives it once the chain shows the nonce free", async () => {
      const store = createMemoryStateStore();
      const { bot, clients } = storeBot(store);
      // Chain nonce stays 0 (the failed tx never broadcast), so next-cycle reconcile can prove
      // the reserved nonce is free and re-drive. First send throws, second succeeds.
      clients.publicClient.getTransactionCount = vi.fn().mockResolvedValue(0);
      clients.sender.send = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue("0xtxhash");

      global.fetch = feed([mockPosition]);
      await bot.run(); // send fails → intent kept LIVE (not terminal), never re-driven this cycle
      const id = store.all()[0].id;
      expect(store.get(id)?.status).toBe("submitted");

      global.fetch = feed([mockPosition]);
      await bot.run(); // cycle-start reconcile: nonce free ⇒ terminal ⇒ re-drive
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
      expect(store.get(id)?.status).toBe("confirmed");
    });

    it("holds (does not re-drive) a live intent whose reserved nonce is still in the mempool", async () => {
      const store = createMemoryStateStore();
      const { bot, clients } = storeBot(store);
      // Run 1: chain nonce 6 → the send reserves 6 then throws AFTER (mocked) broadcast.
      clients.publicClient.getTransactionCount = vi.fn().mockResolvedValue(6);
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

      global.fetch = feed([mockPosition]);
      await bot.run(); // send throws → intent kept live at nonce 6
      const id = store.all()[0].id;
      expect(store.get(id)?.status).toBe("submitted");
      expect(store.get(id)?.nonce).toBe(6);

      // Run 2: the ambiguous tx is now visible in the mempool — pending advanced past nonce 6.
      clients.publicClient.getTransactionCount = vi
        .fn()
        .mockImplementation(({ blockTag }: { blockTag: string }) =>
          Promise.resolve(blockTag === "pending" ? 7 : 6)
        );
      global.fetch = feed([mockPosition]);
      await bot.run(); // reconcile: pending(7) > nonce(6), latest(6) ⇒ hold, no re-drive
      expect(clients.sender.send).toHaveBeenCalledTimes(1);
    });

    it("allocates nonces from the persisted lease, seeded from the chain", async () => {
      const store = createMemoryStateStore();
      const { bot, clients } = storeBot(store);
      // Chain's next nonce is 7; the lease should seed there and the tx use it.
      clients.publicClient.getTransactionCount = vi.fn().mockResolvedValue(7);
      global.fetch = feed([mockPosition]);

      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ nonce: 7 }),
        expect.any(Function)
      );
    });

    it("does not mark an intent failed when post-broadcast bookkeeping fails", async () => {
      const store = createMemoryStateStore();
      // The 'submitted' write fails *after* writeContract has broadcast the tx. This must not
      // flip the intent to terminal 'failed' (which would let the next run double-submit).
      const realTransition = store.transition;
      store.transition = (async (id, to, meta) => {
        if (to === "submitted") throw new Error("db blip after broadcast");
        return realTransition(id, to, meta);
      }) as typeof store.transition;

      const { bot, clients } = storeBot(store);
      global.fetch = feed([mockPosition]);
      await bot.run();

      expect(clients.sender.send).toHaveBeenCalledOnce();
      expect(store.all()[0]?.status).not.toBe("failed");
    });

    it("stops the cycle on a send error (does not send later candidates at a gapped nonce)", async () => {
      const store = createMemoryStateStore();
      const { bot, clients } = storeBot(store);
      clients.publicClient.getTransactionCount = vi.fn().mockResolvedValue(10);
      const p2: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        borrower: "0xborrower0000000000000000000000000000000002",
      };
      const p3: LiquidatablePosition = {
        ...mockPosition,
        proxyAddress: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
        borrower: "0xborrower0000000000000000000000000000000003",
      };
      clients.sender.send = vi
        .fn()
        .mockResolvedValueOnce("0xA") // p1 @ nonce 10 — ok
        .mockRejectedValueOnce(new Error("send failed")); // p2 @ nonce 11 — fails → break
      global.fetch = feed([mockPosition, p2, p3]);

      await bot.run();

      // p1 sent (10), p2 attempted (11) and failed → cycle stops → p3 NOT attempted.
      expect(clients.sender.send).toHaveBeenCalledTimes(2);
      expect(clients.sender.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ nonce: 10 }),
        expect.any(Function)
      );
      expect(clients.sender.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ nonce: 11 }),
        expect.any(Function)
      );
    });
  });

  describe("execution identity", () => {
    const feed = () =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ liquidatable: [mockPosition], total: 1, checked: 1 }),
      });

    it("reads identity off the sender (intent chain id + simulation `from`)", async () => {
      const store = createMemoryStateStore();
      const clients = createMockClients(); // sender identity: { from: 0xliquidator, chainId: 31337 }
      const bot = createBot(clients, { store });
      global.fetch = feed();

      await bot.run();

      expect(store.all()[0]?.chainId).toBe(31337);
      expect(clients.publicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({ account: "0xliquidator" })
      );
    });

    it("follows the sender's identity, not the wallet (the keyless-MANUAL substitution)", async () => {
      const store = createMemoryStateStore();
      const clients = createMockClients();
      // A sender carrying the OPERATOR's identity — as a keyless MANUAL bot would inject. The
      // wallet still says chain 31337 / 0xliquidator, but the sender is the source of truth.
      clients.sender = mockSender({ from: "0xoperator" as `0x${string}`, chainId: 424242 });
      const bot = createBot(clients, { store });
      global.fetch = feed();

      await bot.run();

      expect(store.all()[0]?.chainId).toBe(424242);
      expect(clients.publicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({ account: "0xoperator" })
      );
    });
  });

  // End-to-end at the engine level: a MANUAL bot finds opportunities the same way (risk gate,
  // simulation, all keyless reads) and, at the commit, writes a proposal + notifies instead of
  // broadcasting. The `Executor` seam is unit-tested in `executor.test.ts`; this proves the engine
  // loop drives it correctly — including the keyless promise (no signer nonce reads).
  describe("MANUAL mode (keyless)", () => {
    const OPERATOR = "0xoperator00000000000000000000000000000000" as `0x${string}`;
    // Unlike AUTO's mocked sender, MANUAL's `propose` ABI-encodes the call for real — so the
    // position's addresses must be valid hex. `mockPosition.borrower` is a readable placeholder
    // (`0xborrower…`, not hex), which the encoder rejects; give this one a real address.
    const manualPosition: LiquidatablePosition = {
      ...mockPosition,
      borrower: "0x00000000000000000000000000000000000b0b01",
    };
    const feed = () =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ liquidatable: [manualPosition], total: 1, checked: 1 }),
      });

    function manualBot(store: MemoryStateStore) {
      const clients = createMockClients();
      const events: NotificationEvent[] = [];
      const notifier: Notifier = { notify: async (e) => void events.push(e) };
      // A keyless publicClient for the executor (reconcile's reader + allowance reads). Its
      // `getTransactionCount` is spied so the test can prove a MANUAL cycle issues NO nonce reads.
      const getTransactionCount = vi.fn(async () => 0);
      const executorPublicClient = {
        getTransaction: vi.fn(async () => ({ hash: "0xhash" })),
        getTransactionReceipt: vi.fn(),
        readContract: vi.fn(async () => 0n),
        getTransactionCount,
      } as unknown as PublicClient;
      const executor = createManualExecutor({
        store,
        publicClient: executorPublicClient,
        notifier,
        identity: { from: OPERATOR, chainId: 31337 },
        logger: silentLogger,
      });
      // Injecting an executor makes the engine keyless: no `walletClient`, `sender`, or `nonces`.
      // The adapter/LLP addresses must be real hex too — MANUAL encodes the call + hashes the
      // payload (`getAddress`) for real, where AUTO's mocked sender skips both.
      const bot = createBot(clients, {
        store,
        executor,
        adapterAddress: "0x00000000000000000000000000000000000ada01",
        llpAddress: "0x0000000000000000000000000000000000011b01",
      });
      return { bot, clients, events, getTransactionCount };
    }

    it("proposes + notifies for a liquidatable position, broadcasting nothing", async () => {
      const store = createMemoryStateStore();
      const { bot, clients, events } = manualBot(store);
      global.fetch = feed();

      await bot.run();

      // A proposal was persisted (keyless: `proposed`, no nonce) — not a broadcast.
      const row = store.all()[0];
      expect(row).toMatchObject({
        action: "liquidation",
        subject: mockPosition.proxyAddress,
        status: "proposed",
        nonce: null,
      });
      // The operator was notified once, with the payload hash out-of-band (their tamper check).
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "manual-intent",
        action: "liquidation",
        subject: mockPosition.proxyAddress,
        payloadHash: row?.payloadHash,
      });
      // Nothing was signed or broadcast — the (unused) AUTO sender is never touched.
      expect(clients.sender.send).not.toHaveBeenCalled();
    });

    it("issues no signer nonce reads across the cycle (the keyless bar)", async () => {
      const store = createMemoryStateStore();
      const { bot, clients, getTransactionCount } = manualBot(store);
      global.fetch = feed();

      await bot.run();

      expect(getTransactionCount).not.toHaveBeenCalled();
      expect(clients.publicClient.getTransactionCount).not.toHaveBeenCalled();
    });

    it("dedups across cycles — one proposal, one notification for a stable position", async () => {
      const store = createMemoryStateStore();
      const { bot, events } = manualBot(store);
      global.fetch = feed();

      await bot.run();
      await bot.run();

      expect(store.all()).toHaveLength(1);
      expect(events).toHaveLength(1);
    });
  });
});
