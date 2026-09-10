import { createRiskGate } from "@repo/risk";
import { type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Executor } from "./executor";
import { settledOutflows } from "./outflows";

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

/** `receipt` undefined ⇒ viem's "not found"; `receiptFails` ⇒ any other RPC failure. */
const clients = (
  over: { receipt?: unknown; receiptFails?: boolean; inFlight?: ReadonlySet<string> } = {}
) => {
  const getTransactionReceipt = vi.fn(async () => {
    if (over.receiptFails) throw new Error("rpc down");
    if (over.receipt === undefined) throw new TransactionReceiptNotFoundError({ hash: TX as Hex });
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

describe("settledOutflows", () => {
  it("keeps a hold whose transaction has no receipt and is still in flight", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: new Set([TX]) });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
  });

  it("settles one whose receipt is at or below the height being published", async () => {
    const risk = held();
    const { publicClient, executor } = clients({
      receipt: { blockNumber: 11n },
      inFlight: new Set([TX]),
    });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([TX]);
  });

  // A receipt from a block the read has not reached proves the money moved, and equally proves
  // this read cannot be reporting it.
  it("keeps one whose receipt is above that height", async () => {
    const risk = held();
    const { publicClient, executor } = clients({
      receipt: { blockNumber: 12n },
      inFlight: new Set([TX]),
    });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
  });

  // Dropped or replaced: no receipt will ever exist, and reconcile no longer lists it.
  it("settles one the chain has moved past, with no receipt", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: new Set() });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([TX]);
  });

  // A failed lookup is not "no receipt": the tx may have mined above the read's height.
  it("keeps one whose receipt lookup fails, even when it is no longer in flight", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ receiptFails: true, inFlight: new Set() });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
  });

  // Without a store, "not in flight" is unanswerable, and an unanswered question is not "gone".
  it("keeps one when in-flight cannot be answered at all", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: undefined });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
  });

  it("uses the height the receipt already gave the engine, without asking again", async () => {
    const risk = held({ minedAtBlock: 11n });
    const { publicClient, executor, getTransactionReceipt } = clients({ inFlight: new Set([TX]) });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([TX]);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("keeps a known-mined hold until the read reaches its block", async () => {
    const risk = held({ minedAtBlock: 12n });
    const { publicClient, executor } = clients({ inFlight: new Set([TX]) });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
  });

  // The caller applies the result and the fresh balances in one synchronous `applySnapshot`, so no
  // action can be judged against a balance that lost the hold before gaining the read.
  it("never changes the gate itself", async () => {
    const risk = held();
    const { publicClient, executor } = clients({ inFlight: new Set() });

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([TX]);
    expect(risk.outflows()).toEqual([{ txHash: TX }]);
  });

  it("asks nothing when there is nothing held", async () => {
    const risk = createRiskGate();
    const { publicClient, executor, getTransactionReceipt } = clients({});

    expect(await settledOutflows({ publicClient, risk, executor, block: 11n })).toEqual([]);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(executor.inFlightTxHashes).not.toHaveBeenCalled();
  });
});
