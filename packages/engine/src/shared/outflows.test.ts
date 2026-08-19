import { createRiskGate } from "@repo/risk";
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Executor } from "./executor";
import { retireSettledOutflows } from "./outflows";

const SIGNER = "0xsigner";
const WBTC = "0xwbtc";
const TX = "0xtx";

/** A gate holding one 60-unit outflow against a 100 balance read at block 10. */
function held(outcome: { minedAtBlock?: bigint } = {}) {
  const risk = createRiskGate();
  risk.setAvailable({ owner: SIGNER, token: WBTC }, 100n, 10n);
  risk
    .openSlot({
      kind: "liquidation",
      subject: "0xpos",
      spend: [{ owner: SIGNER, token: WBTC, amount: 60n }],
    })
    .settle({ ok: false, unresolved: true, txHash: TX, ...outcome });
  return risk;
}

const clients = (over: { receipt?: unknown; inFlight?: ReadonlySet<string> | undefined } = {}) => {
  const getTransactionReceipt = vi.fn(async () => {
    if (over.receipt === undefined) throw new Error("not found");
    return over.receipt;
  });
  return {
    publicClient: { getTransactionReceipt } as unknown as PublicClient,
    executor: {
      inFlightTxHashes: vi.fn(async () => over.inFlight),
    } as unknown as Executor,
    getTransactionReceipt,
  };
};

/** Can the account still afford `amount` under the gate's current view? */
const affords = (risk: ReturnType<typeof createRiskGate>, amount: bigint) =>
  risk.openSlot({
    kind: "liquidation",
    subject: "0xother",
    spend: [{ owner: SIGNER, token: WBTC, amount }],
  }).allowed;

describe("retireSettledOutflows", () => {
  it("keeps a hold whose transaction has no receipt and is still in flight", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: new Set([TX]) });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toHaveLength(1);
    expect(affords(risk, 60n)).toBe(false);
  });

  it("retires one whose receipt is at or below the height being published", async () => {
    const risk = held();
    const { publicClient, executor } = clients({
      receipt: { blockNumber: 11n },
      inFlight: new Set([TX]),
    });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toEqual([]);
  });

  // The direction that matters: a receipt from a block the read has not reached yet proves the
  // money moved, and equally proves this read cannot be reporting it.
  it("keeps one whose receipt is above that height", async () => {
    const risk = held();
    const { publicClient, executor } = clients({
      receipt: { blockNumber: 12n },
      inFlight: new Set([TX]),
    });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toHaveLength(1);
  });

  // Dropped or replaced: no receipt will ever exist, so without this the hold would outlive the
  // transaction and quietly shrink the account for the life of the process.
  it("retires one the chain has moved past, with no receipt", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: new Set() });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toEqual([]);
    expect(affords(risk, 100n)).toBe(true);
  });

  // Without a store nothing recorded what was broadcast, so "not in flight" is unanswerable — and
  // an unanswered question must not read as "gone".
  it("keeps one when in-flight cannot be answered at all", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: undefined });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toHaveLength(1);
  });

  it("uses the height the receipt already gave the engine, without asking again", async () => {
    const risk = held({ minedAtBlock: 11n });
    const { publicClient, executor, getTransactionReceipt } = clients({ inFlight: new Set([TX]) });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toEqual([]);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("keeps a known-mined hold until the read reaches its block", async () => {
    const risk = held({ minedAtBlock: 12n });
    const { publicClient, executor } = clients({ inFlight: new Set([TX]) });

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(risk.outflows()).toHaveLength(1);
  });

  it("asks nothing when there is nothing held", async () => {
    const risk = createRiskGate();
    const { publicClient, executor, getTransactionReceipt } = clients({});

    await retireSettledOutflows({ publicClient, risk, executor, block: 11n });

    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(executor.inFlightTxHashes).not.toHaveBeenCalled();
  });
});
