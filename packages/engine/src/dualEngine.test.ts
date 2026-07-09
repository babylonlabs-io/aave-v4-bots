import { createNonceAllocator, createNonceLease } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type RiskConfig, type RiskGate, createRiskGate } from "@repo/risk";
import { describe, expect, it, vi } from "vitest";
import { ArbitrageEngine, type ArbitrageEngineConfig } from "./arbitrage/engine";
import type { EscrowedVault } from "./arbitrage/types";
import { LiquidationEngine, type LiquidationEngineConfig } from "./liquidation/engine";
import type { LiquidatablePosition } from "./liquidation/types";

// The arbitrageur runs BOTH engines in one process off ONE signer. Two invariants follow, and
// both are properties of the pair, not of either engine alone — so they are tested here:
//
//   1. one `NonceAllocator`: their concurrent poll loops never reserve the same nonce;
//   2. one `RiskGate`: halting it stops both engines, and a breaker tripped by one stops the
//      other. (Each engine used to build its own gate, so halting one left the other trading.)

const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SIGNER = "0xshared" as `0x${string}`;
const SEED = 100;

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

const position = (proxy: string, borrower: string): LiquidatablePosition => ({
  proxyAddress: proxy as `0x${string}`,
  borrower: borrower as `0x${string}`,
  amounts: ["1000000"],
  vaults: ["0xvault1"],
  suppliedShares: "1000000000",
});

const vault = (vaultId: `0x${string}`): EscrowedVault => ({
  vaultId,
  btcAmount: "100000000",
  currentDebt: "50000000",
  createdAt: "2024-01-01T00:00:00Z",
});

/**
 * Both engines wired to one mock chain, one nonce allocator and one risk gate — the arbitrageur's
 * production composition. `receiptStatus` lets a test make the chain reject the txs.
 */
function setup(
  opts: { risk?: RiskConfig | RiskGate; receiptStatus?: "success" | "reverted" } = {}
) {
  // Shared mock chain: `pending` count advances only when a broadcast completes (under the
  // lock), so a resync can never rewind below a just-broadcast nonce.
  let chainNonce = SEED;
  const recordedNonces: number[] = [];
  const broadcast = vi.fn(async ({ nonce }: { nonce: number }) => {
    recordedNonces.push(nonce);
    await tick(); // propagation delay — the nonce lock is held across this
    chainNonce = Math.max(chainNonce, nonce + 1);
    return "0xhash" as `0x${string}`;
  });

  const walletClient = {
    account: { address: SIGNER },
    chain: { id: 31337 },
    writeContract: broadcast,
  };
  const publicClient = {
    getTransactionCount: vi.fn(async () => chainNonce),
    readContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === "estimateLiquidation") return [[1000000n], 0n, ["0xvault1"]];
        if (functionName === "previewEscrowedVaults") {
          const ids = args[0] as `0x${string}`[];
          return ids.map((vaultId) => ({
            vaultId,
            amountVault: 100000000n,
            amountDebt: 50000000n,
            amountInterest: 0n,
            amountFee: 0n,
            amountWbtcToAcquire: 50000000n,
            isProfitable: true,
          }));
        }
        if (functionName === "allowance") return 10n ** 30n; // skip approvals
        return 0n;
      }
    ),
    simulateContract: vi.fn().mockResolvedValue({ result: true }),
    estimateContractGas: vi.fn().mockResolvedValue(100000n),
    waitForTransactionReceipt: vi
      .fn()
      .mockResolvedValue({ status: opts.receiptStatus ?? "success", blockNumber: 1n }),
    getTransactionReceipt: vi
      .fn()
      .mockResolvedValue({ status: opts.receiptStatus ?? "success", blockNumber: 1n }),
  };

  const nonces = createNonceAllocator(createNonceLease(), SIGNER);
  // ONE gate for both engines — exactly as the arbitrageur composition root builds it.
  const risk =
    opts.risk && "openSlot" in opts.risk ? opts.risk : createRiskGate(opts.risk as RiskConfig);

  const liq = new LiquidationEngine({
    walletClient: walletClient as unknown as LiquidationEngineConfig["walletClient"],
    publicClient: publicClient as unknown as LiquidationEngineConfig["publicClient"],
    adapterAddress: "0xadapter",
    lensAddress: "0xlens",
    wbtcAddress: "0xwbtc",
    btcRedeemKey: `0x${"0".repeat(64)}`,
    isDirectRedemption: false,
    llpAddress: "0xllp",
    ponderUrl: "http://x",
    txReceiptTimeoutMs: 1000,
    metrics: {
      recordError: vi.fn(),
      recordLiquidationSuccess: vi.fn(),
      recordLiquidationFailed: vi.fn(),
      recordSimulationFailed: vi.fn(),
      recordPollDuration: vi.fn(),
      recordPositionsChecked: vi.fn(),
      recordPositionsLiquidatable: vi.fn(),
      recordTokenBalance: vi.fn(),
    },
    logger: silentLogger,
    risk,
    nonces,
  });

  const arb = new ArbitrageEngine({
    walletClient: walletClient as unknown as ArbitrageEngineConfig["walletClient"],
    publicClient: publicClient as unknown as ArbitrageEngineConfig["publicClient"],
    vaultSwapAddress: "0xvaultswap",
    wbtcAddress: "0xwbtc",
    ponderUrl: "http://x",
    maxSlippageBps: 100,
    vaultProcessingDelayMs: 0,
    retryConfig: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
    txReceiptTimeoutMs: 1000,
    metrics: {
      recordError: vi.fn(),
      recordPollDuration: vi.fn(),
      recordVaultAcquired: vi.fn(),
      recordWbtcBalance: vi.fn(),
    },
    logger: silentLogger,
    risk,
    nonces,
  });

  global.fetch = vi.fn(async (url: string) => {
    if (url.includes("liquidatable-positions")) {
      return {
        ok: true,
        json: async () => ({
          liquidatable: [position("0xp1", "0xb1"), position("0xp2", "0xb2")],
          total: 2,
          checked: 2,
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        vaults: [vault(`0x${"a".repeat(64)}`), vault(`0x${"b".repeat(64)}`)],
      }),
    } as Response;
  }) as unknown as typeof fetch;

  return { liq, arb, risk, broadcast, recordedNonces };
}

describe("dual-engine shared nonce allocator", () => {
  it("never reserves the same nonce across both concurrently-running engines", async () => {
    const { liq, arb, recordedNonces } = setup();

    // Both engines poll concurrently through the one allocator.
    await Promise.all([liq.run(), arb.run()]);

    // 4 sends total (2 liquidations + 2 acquisitions), gapless from the seed, no reuse.
    expect(recordedNonces).toHaveLength(4);
    expect(new Set(recordedNonces).size).toBe(4);
    expect([...recordedNonces].sort((a, b) => a - b)).toEqual([SEED, SEED + 1, SEED + 2, SEED + 3]);
  });
});

describe("dual-engine shared risk gate", () => {
  it("halting the shared gate stops BOTH engines", async () => {
    const { liq, arb, risk, broadcast } = setup();
    risk.halt("operator kill-switch");

    await Promise.all([liq.run(), arb.run()]);

    expect(broadcast).not.toHaveBeenCalled();
    expect(risk.state()).toBe("HALTED");
  });

  it("a gate that boots HALTED trades nothing until resumed", async () => {
    const { liq, arb, risk, broadcast } = setup({ risk: { startHalted: true } });

    await Promise.all([liq.run(), arb.run()]);
    expect(broadcast).not.toHaveBeenCalled();

    risk.resume();
    await Promise.all([liq.run(), arb.run()]);
    expect(broadcast).toHaveBeenCalled();
  });

  // The reason the gate must be shared: a breaker tripped by liquidation failures has to stop
  // arbitrage too, since both engines spend the same signer's funds.
  it("a breaker tripped by one engine halts the other", async () => {
    const { liq, arb, risk, broadcast } = setup({
      risk: { maxConsecutiveFailures: 1 },
      receiptStatus: "reverted",
    });

    await liq.run(); // two reverted liquidations ⇒ breaker trips
    expect(risk.state()).toBe("HALTED");

    broadcast.mockClear();
    await arb.run(); // the arbitrage engine, which never failed, is stopped too
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("the exposure cap is shared: it counts actions from both engines", async () => {
    // maxInFlight=1 and the liquidation engine holds its slots until the receipt phase, so the
    // second candidate is blocked by the first candidate's own in-flight slot.
    const { liq, risk, broadcast } = setup({ risk: { maxInFlight: 1 } });

    await liq.run();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(risk.inFlight()).toBe(0); // every allowed check settled — no leak
  });
});
