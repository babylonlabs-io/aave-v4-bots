import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { SAFE_SCAN_REORG_MARGIN_BLOCKS, findSafeExecutionByHash } from "./queries";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const SAFE_TX_HASH = `0x${"a".repeat(64)}` as Hex;
const TX = `0x${"b".repeat(64)}` as Hex;

/** A chain at `head` that emitted the SafeTx's execution in `at`. */
function chain(head: bigint, at?: bigint) {
  const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) =>
    at !== undefined && fromBlock <= at
      ? [
          {
            eventName: "ExecutionSuccess",
            args: { txHash: SAFE_TX_HASH },
            transactionHash: TX,
          },
        ]
      : []
  );
  return {
    client: {
      getBlockNumber: vi.fn(async () => head),
      getLogs,
    } as unknown as PublicClient,
    getLogs,
  };
}

// The answer this produces decides whether `operator-cli release` frees a claim. Reading "not
// executed" for a SafeTx that DID execute is the dangerous direction: the claim is released, the
// subject re-proposed, and the same fund-moving action signed again under a fresh nonce. So the
// window is deliberately wider than the recorded anchor.
describe("findSafeExecutionByHash", () => {
  it("finds an execution at the anchor", async () => {
    const { client } = chain(500n, 400n);
    expect(await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 400n)).toMatchObject({
      txHash: TX,
      success: true,
    });
  });

  // A reorg moved the block it landed in, or the endpoint answering `getLogs` trails the one that
  // recorded the anchor. Either way the execution sits just below, and starting at the anchor
  // exactly would report it as never having happened.
  it("finds one that landed just below the anchor", async () => {
    const { client } = chain(500n, 400n - SAFE_SCAN_REORG_MARGIN_BLOCKS);
    expect(await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 400n)).not.toBeNull();
  });

  it("does not reach below the genesis end of the chain", async () => {
    const { client, getLogs } = chain(20n);
    await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 3n);
    expect(getLogs.mock.calls.at(-1)?.[0]).toMatchObject({ fromBlock: 0n });
  });

  // An anchor above the chain we can see is an anomaly, not a range. Asking for an inverted one is
  // provider-dependent, and "no logs" from a provider that tolerates it reads as "never executed".
  it("clamps an anchor above the head, and still scans the recent window", async () => {
    const { client, getLogs } = chain(100n, 95n);
    const found = await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 9_999n);
    expect(getLogs.mock.calls.at(-1)?.[0]).toMatchObject({
      fromBlock: 100n - SAFE_SCAN_REORG_MARGIN_BLOCKS,
    });
    expect(found).not.toBeNull();
  });

  // `latest`, not the head just read: an execution landing between the two reads should widen the
  // answer, never escape it.
  it("scans to latest rather than the head it read", async () => {
    const { client, getLogs } = chain(500n, 400n);
    await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 400n);
    expect(getLogs.mock.calls.at(-1)?.[0]).toMatchObject({ toBlock: "latest" });
  });

  it("ignores an unrelated Safe execution", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 500n),
      getLogs: vi.fn(async () => [
        {
          eventName: "ExecutionSuccess",
          args: { txHash: `0x${"c".repeat(64)}` as Hex },
          transactionHash: TX,
        },
      ]),
    } as unknown as PublicClient;
    expect(await findSafeExecutionByHash(client, SAFE, SAFE_TX_HASH, 400n)).toBeNull();
  });
});
