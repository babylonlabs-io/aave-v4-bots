import { describe, expect, it } from "vitest";
import {
  RESERVE_FLAG,
  bufferAmount,
  bufferAmounts,
  isBorrowableReserve,
  selectPositions,
} from "./domain";

describe("bufferAmounts", () => {
  it("applies a 1% buffer by default", () => {
    expect(bufferAmounts([10_000n, 200n])).toEqual([10_100n, 202n]);
  });

  it("supports a custom buffer in bps", () => {
    expect(bufferAmounts([10_000n], 250)).toEqual([10_250n]);
  });

  it("buffers every nonzero amount by at least one unit", () => {
    // Truncation would give 1n * 10100 / 10000 = 1: no buffer at all below 100 units.
    expect(bufferAmounts([1n, 99n])).toEqual([2n, 100n]);
  });

  it("returns an empty array for no amounts", () => {
    expect(bufferAmounts([])).toEqual([]);
  });
});

describe("bufferAmount", () => {
  it("applies a 1% buffer by default", () => {
    expect(bufferAmount(10_000n)).toBe(10_100n);
  });

  it("supports a custom buffer in bps", () => {
    expect(bufferAmount(10_000n, 250)).toBe(10_250n);
  });

  it("buffers every nonzero amount by at least one unit", () => {
    // Every value this produces is an on-chain cap, so an unbuffered small amount reverts on the
    // first upward tick. Truncation would leave 99n at 99n.
    expect(bufferAmount(1n)).toBe(2n);
    expect(bufferAmount(99n)).toBe(100n);
  });

  it("leaves zero at zero", () => {
    // A zero quote is a zero cap. Rounding up must not invent a payment where none was quoted.
    expect(bufferAmount(0n)).toBe(0n);
  });

  it("agrees with plain truncation once the buffer is a whole unit", () => {
    // Above 10_000 / bufferBps the two coincide, which is why no other test in the engine moves.
    expect(bufferAmount(100n)).toBe(101n);
    expect(bufferAmount(5_000n)).toBe(5_050n);
  });
});

describe("isBorrowableReserve", () => {
  it("is true only when the BORROWABLE bit is set", () => {
    expect(isBorrowableReserve(RESERVE_FLAG.BORROWABLE)).toBe(true);
    expect(isBorrowableReserve(RESERVE_FLAG.BORROWABLE | RESERVE_FLAG.PAUSED)).toBe(true);
    expect(isBorrowableReserve(RESERVE_FLAG.PAUSED | RESERVE_FLAG.FROZEN)).toBe(false);
    expect(isBorrowableReserve(0)).toBe(false);
  });
});

// The indexer is untrusted, so the candidate list is trimmed before any RPC call is made from it.
describe("selectPositions", () => {
  const proxy = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const pos = (proxyAddress: string) => ({ proxyAddress, borrower: "0xb" });

  it("keeps the first entry for each proxy, ignoring case, in feed order", () => {
    const a = proxy(0xa);
    const out = selectPositions([pos(a), pos(proxy(2)), pos(a.toUpperCase().replace("0X", "0x"))]);

    expect(out.positions.map((p) => p.proxyAddress)).toEqual([a, proxy(2)]);
    expect(out).toMatchObject({ duplicates: 1, malformed: 0, truncated: 0 });
  });

  it("caps the list and reports how many it left for later cycles", () => {
    const out = selectPositions(
      Array.from({ length: 7 }, (_, i) => pos(proxy(i))),
      5
    );

    expect(out.positions).toHaveLength(5);
    expect(out.truncated).toBe(2);
  });

  it("drops entries without a usable proxy address", () => {
    const out = selectPositions([
      pos(proxy(1)),
      pos("0xnope"),
      null as unknown as ReturnType<typeof pos>,
      { borrower: "0xb" } as unknown as ReturnType<typeof pos>,
    ]);

    expect(out.positions).toHaveLength(1);
    expect(out.malformed).toBe(3);
  });
});
