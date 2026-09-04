import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MULTICALL_BATCH_BYTES,
  PROBES_PER_CALL,
  PROBE_CHUNK_SIZE,
  type Probe,
  probeInChunks,
  resolveChunkSize,
  selectProbeCandidates,
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

    const { probes, unscanned } = await probeInChunks(items, recording(batches), noop, 2);

    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
    assert.deepEqual(
      probes.map((p) => (p.status === "success" ? p.value : null)),
      items
    );
    assert.equal(unscanned, 0);
  });

  // The whole reason for batching: one aggregate over the full table is one `eth_call`, and past
  // the node's gas cap it reverts entirely. A failure must cost its own batch, not the scan.
  it("keeps the other batches when one fails as a whole", async () => {
    const boom = new Error("out of gas");
    const { probes, unscanned } = await probeInChunks(
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
      probes.map((p) => (p.status === "success" ? p.value : p.error)),
      [1, 2, boom, boom, 5, 6]
    );
    assert.equal(unscanned, 2);
  });

  // A scan that saw nothing and a market with nothing to see produce the same empty candidate
  // list. `unscanned` is the only thing that tells them apart, so it must count every lost item.
  it("counts every item a failed batch cost", async () => {
    const { unscanned } = await probeInChunks(
      [1, 2, 3, 4, 5],
      async () => {
        throw new Error("node refused the batch");
      },
      noop,
      2
    );

    assert.equal(unscanned, 5);
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
    const { probes, unscanned } = await probeInChunks(
      [1, 2, 3, 4],
      async (chunk) => (chunk[0] === 1 ? [ok(1)] : chunk.map(ok)),
      noop,
      2
    );

    assert.equal(probes.length, 4);
    assert.equal(probes[0].status, "failure");
    assert.equal(probes[1].status, "failure");
    assert.deepEqual(
      probes.slice(2).map((p) => (p.status === "success" ? p.value : null)),
      [3, 4]
    );
    assert.equal(unscanned, 2);
  });

  it("returns one probe per item however the batches fall", async () => {
    for (const size of [1, 3, 4, 7, 100]) {
      const items = Array.from({ length: 10 }, (_, i) => i);
      const { probes } = await probeInChunks(items, recording([]), noop, size);
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

    const { probes, unscanned } = await probeInChunks([], recording(batches), noop, 2);

    assert.deepEqual(batches, []);
    assert.deepEqual(probes, []);
    assert.equal(unscanned, 0);
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

// A row exists for the `user` of any `Spoke:Supply`, and that argument is the supplier's choice — so
// the table holds addresses nobody can liquidate, and anyone can add more of them cheaply. They are
// dropped before the scan because probing one costs almost as much as probing a real position and
// can only produce a result the endpoint would throw away.
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

  // The two tables are filled from different events, and nothing makes them agree on checksumming.
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

  // The pairing is what the probe results are indexed by, so an order that did not follow the input
  // would attribute one position's estimate to another's borrower.
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

// viem splits a multicall by calldata bytes and awaits the pieces together, so this constant — not
// the chunk size — is what decides one `eth_call`'s gas. The route passes it as `batchSize`, and
// viem starts a new call only once the accumulated size *exceeds* the limit, so the arithmetic has
// to land exactly on the probe count rather than one either side of it.
describe("MULTICALL_BATCH_BYTES", () => {
  const CALLDATA_BYTES = 68; // estimateLiquidation(address,bool): selector + two words

  it("admits exactly PROBES_PER_CALL probes per eth_call", () => {
    assert.equal(MULTICALL_BATCH_BYTES, PROBES_PER_CALL * CALLDATA_BYTES);
    // viem's condition is `currentChunkSize > batchSize`, so the last probe that fits must not
    // exceed the limit and the next one must.
    assert.ok(PROBES_PER_CALL * CALLDATA_BYTES <= MULTICALL_BATCH_BYTES);
    assert.ok((PROBES_PER_CALL + 1) * CALLDATA_BYTES > MULTICALL_BATCH_BYTES);
  });

  // ~177k gas for a healthy probe, which is the case that sets the price; a liquidatable one is
  // ~247k. The cap this has to stay under is the 10M some providers enforce.
  it("keeps one call inside the tightest provider gas cap", () => {
    assert.ok(PROBES_PER_CALL * 247_000 < 10_000_000);
  });
});
