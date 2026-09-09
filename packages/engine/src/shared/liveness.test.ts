import type { RelayTxStatus } from "@repo/execution";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@repo/logger";
import {
  type ChainReader,
  MAX_RELAY_HORIZON_BLOCKS,
  createRelayAwareReader,
  createRelayHorizon,
} from "./liveness";

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
// The label set on `relay_tx_status_total` is finite only if every value reaching it comes from a
// fixed vocabulary. The adapter guarantees that for the relay's own answers by refusing anything
// outside the union; this is the other half — what the reader reports when it gets no answer at all.
describe("createRelayAwareReader — what reaches the metric", () => {
  const nodeReader = {
    isKnown: async () => false,
    getBlockNumber: async () => 100,
  } as unknown as ChainReader;

  it("reports a fixed label when the probe fails, never the relay's text", async () => {
    const seen: string[] = [];
    const reader = createRelayAwareReader(
      nodeReader,
      {
        status: async () => {
          throw new Error(
            `flashbots status returned an unknown status: ${"PENDING-1".repeat(500)}`
          );
        },
      },
      { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      (s) => seen.push(s)
    );

    // Fail-closed: an unreadable probe still reports the transaction as in flight.
    await expect(reader.isKnown(HASH)).resolves.toBe(true);
    expect(seen).toEqual(["probe_error"]);
  });

  it("passes through only statuses the adapter would have allowed", async () => {
    const seen: string[] = [];
    const reader = createRelayAwareReader(
      nodeReader,
      {
        status: async () => ({
          status: "PENDING" as const,
          maxBlockNumber: 0,
          isRevert: false,
          seenInMempool: false,
        }),
      },
      { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      (s) => seen.push(s)
    );

    await reader.isKnown(HASH);

    expect(seen).toEqual(["PENDING"]);
  });
});

describe("createRelayHorizon — what the relay is allowed to claim", () => {
  const warn = vi.fn();
  beforeEach(() => warn.mockClear());

  // This number is the only thing that ever frees a privately-submitted nonce. A relay that names a
  // deadline far enough out fences that nonce permanently, and the value is well-formed — no
  // validation of the response can catch it, because there is nothing wrong with the number itself.
  it("will not fence past the absolute ceiling, however far out the relay claims", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 1_000_000_000 }), 25, {
      warn,
    }).resolve;

    expect(await horizon(HASH)).toBe(100 + MAX_RELAY_HORIZON_BLOCKS);
  });

  // Capping quietly would leave the operator watching a nonce that just takes longer to come back.
  it("says when it caps one", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 1e9 }), 25, {
      warn,
    }).resolve;

    await horizon(HASH);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`beyond the ${MAX_RELAY_HORIZON_BLOCKS} blocks`))
    );
  });

  // A cap derived from the configured window would point the wrong way: a short declaration would
  // shrink the cap with it and truncate the relay's true, longer deadline, freeing the nonce while
  // the transaction could still be included. The cap bounds a broken relay; it does not overrule an
  // honest one.
  it("honours a deadline past a multiple of a small configured window", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 125 }), 1, {
      warn,
    }).resolve;

    expect(await horizon(HASH)).toBe(125);
    expect(warn).not.toHaveBeenCalled();
  });

  // Both directions of the same rule: the configured window is a floor under the relay's answer,
  // never a competing one. Whichever is later is the one that keeps the nonce fenced.
  it("keeps the configured window when the relay declares something shorter", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 105 }), 25, {
      warn,
    }).resolve;

    expect(await horizon(HASH)).toBe(125);
  });

  it("leaves an ordinary deadline alone, and says nothing", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 200 }), 25, {
      warn,
    }).resolve;

    expect(await horizon(HASH)).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  // The boundary itself is believed: a relay may legitimately declare the longest window we honour.
  it("believes a deadline exactly at the ceiling", async () => {
    const ceiling = 100 + MAX_RELAY_HORIZON_BLOCKS;
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: ceiling }), 25, {
      warn,
    }).resolve;

    expect(await horizon(HASH)).toBe(ceiling);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createRelayHorizon", () => {
  it("takes the relay's own deadline over the declared window", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 130 }), 4).resolve;
    expect(await horizon(HASH)).toBe(130);
  });

  // The relay is authoritative about its own window, but not trusted to shorten ours: a relay
  // reporting a deadline it has already passed would free a nonce it may still spend.
  it("never goes below the declared window, even when the relay reports a nearer deadline", async () => {
    const horizon = createRelayHorizon(node(100), relay({ maxBlockNumber: 101 }), 25).resolve;
    expect(await horizon(HASH)).toBe(125);
  });

  // Expected, not exceptional: a status probe issued the moment after submission routinely finds
  // the transaction unindexed, and Protect answers `UNKNOWN` with no deadline at all.
  it("falls back to the declared window when the relay states no deadline", async () => {
    const horizon = createRelayHorizon(node(100), relay({ status: "UNKNOWN" }), 25).resolve;
    expect(await horizon(HASH)).toBe(125);
  });

  it("falls back when the probe fails outright", async () => {
    const horizon = createRelayHorizon(
      node(100),
      { status: async () => Promise.reject("503") },
      25
    ).resolve;
    expect(await horizon(HASH)).toBe(125);
  });
});

// Recovering the horizon of a transaction whose own submission never recorded one. Every branch
// that cannot *prove* the deadline it would record declines, because the two mistakes cost
// differently: fencing too long stalls the bot visibly, while recording a deadline shorter than the
// relay's real one hands out a nonce the relay can still spend.
//
// Built through the same bundle production wires, and the window it is given is load-bearing: at
// head 100 a configured 25 would surface as a horizon of 125, which no assertion below expects. So
// every `toBeNull` here also proves the repair never falls back to the window the way submission
// does — the asymmetry that makes it safe to run against a row of unproven provenance.
describe("repairHorizon", () => {
  const warn = vi.fn();
  beforeEach(() => warn.mockReset());

  it("records the relay's own declared deadline", async () => {
    const repair = createRelayHorizon(node(100), relay({ maxBlockNumber: 200 }), 25, {
      warn,
    }).repair;

    expect(await repair(HASH)).toBe(200);
  });

  // The migration case. A public submission leaves `relayMaxBlock` null exactly as a lost horizon
  // write does, and the reading process's own config cannot tell the two apart. A relay that never
  // received the hash can: it answers UNKNOWN. Repairing anyway would stamp a relay deadline on a
  // public transaction and then release its nonce while it still sat in the mempool — where it may
  // legitimately linger forever.
  it("declines a hash the relay has never received", async () => {
    const repair = createRelayHorizon(node(100), relay({ status: "UNKNOWN" }), 25, {
      warn,
    }).repair;

    expect(await repair(HASH)).toBeNull();
  });

  // The same UNKNOWN also means "held once, since forgotten". Falling back to a configured window
  // there would overwrite a real, longer, no-longer-observable deadline with a short guess.
  it("declines rather than guessing a window for a forgotten hash", async () => {
    const repair = createRelayHorizon(
      node(100),
      relay({ status: "UNKNOWN", maxBlockNumber: 0 }),
      25,
      {
        warn,
      }
    ).repair;

    expect(await repair(HASH)).toBeNull();
  });

  // Held by the relay AND in the public mempool, so the relay's deadline does not bound when the
  // transaction can be included. `seenInMempool` is the leak the private route is meant to prevent.
  it("declines a transaction that leaked to the public mempool", async () => {
    const repair = createRelayHorizon(
      node(100),
      relay({ maxBlockNumber: 200, seenInMempool: true }),
      25,
      { warn }
    ).repair;

    expect(await repair(HASH)).toBeNull();
  });

  // Held, but naming no deadline of its own — `maxBlockNumber` is absent and parses as 0. That is
  // no more evidence than UNKNOWN, and a fresh window here would recreate the same asymmetry.
  it("declines when the relay names no deadline", async () => {
    const repair = createRelayHorizon(node(100), relay({ maxBlockNumber: 0 }), 25, {
      warn,
    }).repair;

    expect(await repair(HASH)).toBeNull();
  });

  // Terminal statuses still carry a real deadline, and a terminal answer is not what releases a
  // nonce — the horizon is. See `createRelayAwareReader`.
  it.each(["INCLUDED", "FAILED", "CANCELLED"] as const)("repairs on %s", async (status) => {
    const repair = createRelayHorizon(node(100), relay({ status, maxBlockNumber: 150 }), 25, {
      warn,
    }).repair;

    expect(await repair(HASH)).toBe(150);
  });

  // Fails closed like every other relay read: the caller keeps the row fenced and tries next pass.
  it("propagates a failed probe rather than reporting no deadline", async () => {
    const repair = createRelayHorizon(
      node(100),
      {
        status: async () => {
          throw new Error("flashbots 503");
        },
      },
      25,
      { warn }
    ).repair;

    await expect(repair(HASH)).rejects.toThrow("flashbots 503");
  });

  it("caps an implausible declaration, and says so", async () => {
    const repair = createRelayHorizon(node(100), relay({ maxBlockNumber: 1e9 }), 25, {
      warn,
    }).repair;

    expect(await repair(HASH)).toBe(100 + MAX_RELAY_HORIZON_BLOCKS);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`beyond the ${MAX_RELAY_HORIZON_BLOCKS} blocks`))
    );
  });
});
