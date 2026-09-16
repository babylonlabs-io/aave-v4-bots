import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LENS_HEALTHY_POSITION_ERROR, lensAbi } from "@repo/abis";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import {
  type ChunkedProbe,
  MULTICALL_BATCH_BYTES,
  PROBES_PER_CALL,
  PROBE_CHUNK_SIZE,
  type Probe,
  probeInChunks,
  resolveChunkSize,
  selectProbeCandidates,
  summarizeProbes,
} from "../src/probePositions";

const ok = (value: number): Probe<number> => ({ status: "success", value });
const noop = () => {};

/** Succeeds for every item, recording the batches it was handed. */
const recording = (batches: number[][]) => async (chunk: readonly number[]) => {
  batches.push([...chunk]);
  return chunk.map(ok);
};

describe("probeInChunks", () => {
  it("splits the work into batches of the given size", async () => {
    const batches: number[][] = [];
    const items = [1, 2, 3, 4, 5];

    const probes = await probeInChunks(items, recording(batches), noop, 2);

    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
    assert.deepEqual(
      probes.map((p) => (p.status === "success" ? p.value : null)),
      items
    );
  });

  // The whole reason for batching: one aggregate over the full table is one `eth_call`, and past
  // the node's gas cap it reverts entirely. A failure must cost its own batch, not the scan.
  it("keeps the other batches when one fails as a whole", async () => {
    const boom = new Error("out of gas");
    const probes = await probeInChunks(
      [1, 2, 3, 4, 5, 6],
      async (chunk) => {
        if (chunk.includes(3)) throw boom;
        return chunk.map(ok);
      },
      noop,
      2
    );

    assert.equal(probes.length, 6);
    assert.deepEqual(
      probes.map((p) => (p.status === "success" ? p.value : [p.status, p.error])),
      [1, 2, ["unscanned", boom], ["unscanned", boom], 5, 6]
    );
  });

  // A scan that saw nothing and a market with nothing to see produce the same empty candidate
  // list. `unscanned` is the only thing that tells them apart, so it must mark every lost item.
  it("marks every item a failed batch cost as unscanned", async () => {
    const probes = await probeInChunks(
      [1, 2, 3, 4, 5],
      async () => {
        throw new Error("node refused the batch");
      },
      noop,
      2
    );

    assert.deepEqual(
      probes.map((p) => p.status),
      ["unscanned", "unscanned", "unscanned", "unscanned", "unscanned"]
    );
  });

  it("reports each failed batch with its offset and size", async () => {
    const boom = new Error("out of gas");
    const failures: Array<[number, number, unknown]> = [];

    await probeInChunks(
      [1, 2, 3, 4, 5],
      async (chunk) => {
        if (chunk[0] === 3) throw boom;
        return chunk.map(ok);
      },
      (offset, size, error) => failures.push([offset, size, error]),
      2
    );

    assert.deepEqual(failures, [[2, 2, boom]]);
  });

  // Callers index their rows by probe position, so a batch returning the wrong count would
  // attribute one position's liquidation estimate to another position's proxy — a liquidation sent
  // against a healthy borrower. Refuse the batch instead of trusting it.
  it("refuses a batch that returns the wrong number of results", async () => {
    const probes = await probeInChunks(
      [1, 2, 3, 4],
      async (chunk) => (chunk[0] === 1 ? [ok(1)] : chunk.map(ok)),
      noop,
      2
    );

    assert.deepEqual(
      probes.map((p) => (p.status === "success" ? p.value : p.status)),
      ["unscanned", "unscanned", 3, 4]
    );
  });

  it("returns one probe per item however the batches fall", async () => {
    for (const size of [1, 3, 4, 7, 100]) {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const probes = await probeInChunks(items, recording([]), noop, size);
      assert.equal(probes.length, items.length, `chunk size ${size}`);
    }
  });

  it("batches by PROBE_CHUNK_SIZE when no size is given", async () => {
    const batches: number[][] = [];
    const items = Array.from({ length: PROBE_CHUNK_SIZE + 1 }, (_, i) => i);

    await probeInChunks(items, recording(batches), noop);

    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, PROBE_CHUNK_SIZE);
    assert.equal(batches[1].length, 1);
  });

  it("does nothing when there is nothing to probe", async () => {
    const batches: number[][] = [];

    const probes = await probeInChunks([], recording(batches), noop, 2);

    assert.deepEqual(batches, []);
    assert.deepEqual(probes, []);
  });
});

describe("summarizeProbes", () => {
  /** The lens's healthy-position revert, decoded the way viem decodes one off the wire. */
  const healthy = (): ChunkedProbe<number> => ({
    status: "failure",
    error: new ContractFunctionRevertedError({
      abi: lensAbi,
      data: encodeErrorResult({ abi: lensAbi, errorName: LENS_HEALTHY_POSITION_ERROR }),
      functionName: "estimateLiquidation",
    }),
  });
  const fault = (message: string): ChunkedProbe<number> => ({
    status: "failure",
    error: new Error(message),
  });

  // The finding this exists for: a failed batch was counted once as unscanned and again as faults,
  // so `unscanned` doubled and `checked` could go negative.
  it("counts each position of a failed batch once", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => i);
    const probes = await probeInChunks(
      candidates,
      async (chunk) => {
        if (chunk.includes(3)) throw new Error("gas cap exceeded");
        return chunk.map(() => healthy() as Probe<number>);
      },
      noop,
      3
    );

    const summary = summarizeProbes(candidates, probes);

    assert.equal(summary.unscanned, 3);
    assert.equal(summary.checked, 7);
    assert.equal(summary.faults.count, 0);
  });

  it("counts a revert that is not a healthy position once, as a fault", () => {
    const summary = summarizeProbes(["a", "b"], [fault("InvalidOraclePrice"), healthy()]);

    assert.equal(summary.unscanned, 1);
    assert.equal(summary.checked, 1);
    assert.equal(summary.faults.count, 1);
  });

  it("lists each success with its candidate, and counts it as checked", () => {
    const summary = summarizeProbes(["a", "b", "c"], [healthy(), ok(42), healthy()]);

    assert.deepEqual(summary.succeeded, [{ candidate: "b", value: 42 }]);
    assert.equal(summary.checked, 3);
    assert.equal(summary.unscanned, 0);
  });

  it("refuses probes that do not line up with the candidates", () => {
    assert.throws(() => summarizeProbes(["a", "b"], [ok(1)]), /1 probe\(s\) for 2 candidate\(s\)/);
  });
});

describe("resolveChunkSize", () => {
  it("takes a positive integer as given", () => {
    assert.deepEqual(resolveChunkSize("50"), { chunkSize: 50, invalid: false });
    assert.deepEqual(resolveChunkSize("1e3"), { chunkSize: 1000, invalid: false });
  });

  it("uses the measured default when unset", () => {
    assert.deepEqual(resolveChunkSize(undefined), { chunkSize: PROBE_CHUNK_SIZE, invalid: false });
    assert.deepEqual(resolveChunkSize("  "), { chunkSize: PROBE_CHUNK_SIZE, invalid: false });
  });

  // A typo in a tuning knob must not cost the bot its candidate feed, so this falls back rather
  // than throwing — but it reports that it did, because a silently ignored setting is its own trap.
  it("falls back and says so on anything that is not a batch size", () => {
    for (const raw of ["0", "-5", "12.5", "abc", "Infinity", "25 positions"]) {
      assert.deepEqual(resolveChunkSize(raw), { chunkSize: PROBE_CHUNK_SIZE, invalid: true }, raw);
    }
  });
});

// Rows without a borrower cannot be liquidated but cost nearly a full probe, so they are dropped.
describe("selectProbeCandidates", () => {
  const position = (proxyAddress: string) => ({ proxyAddress, suppliedShares: 1n });
  const mapping = (proxyAddress: string, borrower: string) => ({ proxyAddress, borrower });

  it("keeps only the positions a borrower can be resolved for", () => {
    const { candidates, unmapped } = selectProbeCandidates(
      [position("0xaaa"), position("0xbbb"), position("0xccc")],
      [mapping("0xaaa", "0x111"), mapping("0xccc", "0x333")]
    );

    assert.deepEqual(
      candidates.map((c) => [c.position.proxyAddress, c.borrower]),
      [
        ["0xaaa", "0x111"],
        ["0xccc", "0x333"],
      ]
    );
    assert.equal(unmapped, 1);
  });

  // The two tables come from different events and can differ in checksum casing.
  it("matches addresses whatever their case", () => {
    const { candidates, unmapped } = selectProbeCandidates(
      [position("0xAbCd")],
      [mapping("0xaBcD", "0x111")]
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].borrower, "0x111");
    assert.equal(unmapped, 0);
  });

  it("reports an unprobeable table as entirely unmapped", () => {
    const { candidates, unmapped } = selectProbeCandidates([position("0xaaa")], []);

    assert.deepEqual(candidates, []);
    assert.equal(unmapped, 1);
  });

  // Probe results are indexed by this order, so it must follow the input.
  it("keeps the input order", () => {
    const { candidates } = selectProbeCandidates(
      [position("0xccc"), position("0xaaa"), position("0xbbb")],
      [mapping("0xaaa", "0x111"), mapping("0xbbb", "0x222"), mapping("0xccc", "0x333")]
    );

    assert.deepEqual(
      candidates.map((c) => c.position.proxyAddress),
      ["0xccc", "0xaaa", "0xbbb"]
    );
  });
});

// viem splits a multicall by calldata bytes, so `MULTICALL_BATCH_BYTES` sets one call's size. It
// must land exactly on the probe count: viem starts a new call when the size exceeds the limit.
describe("MULTICALL_BATCH_BYTES", () => {
  const CALLDATA_BYTES = 68; // estimateLiquidation(address,bool): selector + two words

  it("admits exactly PROBES_PER_CALL probes per eth_call", () => {
    assert.equal(MULTICALL_BATCH_BYTES, PROBES_PER_CALL * CALLDATA_BYTES);
    // viem starts a new call when `currentChunkSize > batchSize`.
    assert.ok(PROBES_PER_CALL * CALLDATA_BYTES <= MULTICALL_BATCH_BYTES);
    assert.ok((PROBES_PER_CALL + 1) * CALLDATA_BYTES > MULTICALL_BATCH_BYTES);
  });

  // ~177k gas per healthy probe, ~247k per liquidatable one; the cap is 10M on some providers.
  it("keeps one call inside the tightest provider gas cap", () => {
    assert.ok(PROBES_PER_CALL * 247_000 < 10_000_000);
  });
});
