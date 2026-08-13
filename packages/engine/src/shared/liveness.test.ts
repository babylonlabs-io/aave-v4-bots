import type { RelayTxStatus } from "@repo/execution";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { type ChainReader, createRelayHorizon } from "./liveness";

const HASH = "0xhash" as Hex;

const node = (head: number) =>
  ({ getBlockNumber: vi.fn(async () => head) }) as unknown as ChainReader;

const relay = (over: Partial<RelayTxStatus>) => ({
  status: vi.fn(
    async (): Promise<RelayTxStatus> => ({
      status: "PENDING",
      maxBlockNumber: 0,
      isRevert: false,
      seenInMempool: false,
      ...over,
    })
  ),
});

// The horizon is the only thing that ever releases a privately-submitted nonce, so every way of
// resolving it has to err long. These four cases are the ways it can go short.
describe("createRelayHorizon", () => {
  it("takes the relay's own deadline over the declared window", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 130 }), 4);
    expect(await horizon(HASH)).toBe(130);
  });

  // The relay is authoritative about its own window, but not trusted to shorten ours: a relay
  // reporting a deadline it has already passed would free a nonce it may still spend.
  it("never goes below the declared window, even when the relay reports a nearer deadline", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 101 }), 25);
    expect(await horizon(HASH)).toBe(125);
  });

  // Expected, not exceptional: a status probe issued the moment after submission routinely finds
  // the transaction unindexed, and Protect answers `UNKNOWN` with no deadline at all.
  it("falls back to the declared window when the relay states no deadline", async () => {
    const horizon = createRelayHorizon(node(100), relay({ status: "UNKNOWN" }), 25);
    expect(await horizon(HASH)).toBe(125);
  });

  it("falls back when the probe fails outright", async () => {
    const horizon = createRelayHorizon(
      node(100),
      { status: async () => Promise.reject("503") },
      25
    );
    expect(await horizon(HASH)).toBe(125);
  });
});
