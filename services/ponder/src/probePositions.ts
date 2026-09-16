/**
 * Batching for the live contract probes the API runs over every indexed row, and the accounting of
 * their results.
 *
 * Kept apart from the route handler because the handler imports Ponder's virtual `ponder:api`
 * module and cannot be loaded outside a running indexer — this is the part worth testing.
 */

import { FaultTally, isHealthyPositionRevert } from "./probeFaults";

/** Calldata of one `estimateLiquidation(address,bool)`: a selector and two words. */
const ESTIMATE_CALLDATA_BYTES = 68;

/**
 * Probes per `eth_call`; this sets one call's gas. The route passes it to viem's `multicall` as
 * `batchSize`, because viem splits by calldata bytes (1024 by default).
 *
 * Measured: a healthy position costs ~177k gas to probe (`estimateLiquidation` loads every reserve
 * before it reverts), and batching does not amortize it. 15 is ~2.7M gas, inside both geth's 50M
 * default cap and the 10M some providers enforce. The margin covers growth: each extra spoke
 * reserve adds ~21k, each vault ~3k, and a liquidatable position costs ~247k.
 */
export const PROBES_PER_CALL = 15;

/** `PROBES_PER_CALL` as viem's `multicall` wants it: a calldata-byte limit. */
export const MULTICALL_BATCH_BYTES = PROBES_PER_CALL * ESTIMATE_CALLDATA_BYTES;

/**
 * Probes per chunk. A chunk is split into `PROBES_PER_CALL`-sized calls that run concurrently, and
 * chunks run one after another, so this sets concurrency, not per-call gas: 25 is two calls in
 * flight. Raising it cuts latency on a large table but spends RPC capacity the indexer also needs;
 * a throttled chunk fails whole, and its positions count as `unscanned`.
 */
export const PROBE_CHUNK_SIZE = 25;

/**
 * `POSITION_PROBE_CHUNK_SIZE` if it is a positive integer, else the measured default.
 *
 * Bad input falls back rather than throwing: the indexer refusing to boot over a typo in a tuning
 * knob would cost the bot its whole candidate feed, which is far worse than scanning in the default
 * batch size. Returns whether it fell back, so the caller can say so.
 */
export function resolveChunkSize(raw: string | undefined): { chunkSize: number; invalid: boolean } {
  if (raw === undefined || raw.trim() === "")
    return { chunkSize: PROBE_CHUNK_SIZE, invalid: false };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { chunkSize: PROBE_CHUNK_SIZE, invalid: true };
  }
  return { chunkSize: parsed, invalid: false };
}

export type Probe<T> = { status: "success"; value: T } | { status: "failure"; error: unknown };

/** A probe's result, or `unscanned`: the item's batch failed as a whole, so it was never probed. */
export type ChunkedProbe<T> = Probe<T> | { status: "unscanned"; error: unknown };

/**
 * Run `runChunk` over `items` in batches of `chunkSize`, surviving a batch that fails as a whole.
 *
 * A thrown batch costs its own items this cycle and nothing more: they come back as `unscanned`.
 * That distinction is the point — folding them into "probe reverted" would make a partial scan
 * indistinguishable from a quiet market, and "no candidates" is the one answer a liquidator must
 * never infer from a failure.
 *
 * `runChunk` must return one result per item it was given. A short or long batch would shift every
 * later probe against its item, attributing one position's estimate to another's proxy, so it is
 * rejected as a batch failure rather than trusted.
 *
 * Returns exactly one entry per input item, in input order — callers index positions by this.
 */
export async function probeInChunks<I, T>(
  items: readonly I[],
  runChunk: (chunk: readonly I[], offset: number) => Promise<Probe<T>[]>,
  onChunkFailure: (offset: number, size: number, error: unknown) => void,
  chunkSize: number = PROBE_CHUNK_SIZE
): Promise<ChunkedProbe<T>[]> {
  const probes: ChunkedProbe<T>[] = [];

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    try {
      const results = await runChunk(chunk, offset);
      if (results.length !== chunk.length) {
        throw new Error(`batch returned ${results.length} result(s) for ${chunk.length} item(s)`);
      }
      probes.push(...results);
    } catch (error) {
      probes.push(...chunk.map((): ChunkedProbe<T> => ({ status: "unscanned", error })));
      onChunkFailure(offset, chunk.length, error);
    }
  }

  return probes;
}

/**
 * Pair each position with its proxy's borrower, and drop positions without one. Any
 * `Spoke:Supply` creates a position row for an address the supplier chooses. Such a row cannot be
 * liquidated and costs nearly a full probe. Addresses are matched case-insensitively.
 */
export function selectProbeCandidates<
  P extends { proxyAddress: string },
  M extends { proxyAddress: string; borrower: string },
>(
  positions: readonly P[],
  proxyMappings: readonly M[]
): { candidates: { position: P; borrower: string }[]; unmapped: number } {
  const borrowerOf = new Map<string, string>();
  for (const m of proxyMappings) borrowerOf.set(m.proxyAddress.toLowerCase(), m.borrower);

  const candidates = positions.flatMap((position) => {
    const borrower = borrowerOf.get(position.proxyAddress.toLowerCase());
    return borrower ? [{ position, borrower }] : [];
  });

  return { candidates, unmapped: positions.length - candidates.length };
}

export interface ProbeSummary<C, T> {
  /** Each candidate whose probe succeeded, with the value it returned. */
  succeeded: { candidate: C; value: T }[];
  /** Candidates this cycle has an answer for: a success, or the healthy-position revert. */
  checked: number;
  /**
   * Candidates this cycle has no answer for, each counted once: never probed because its batch
   * failed, or reverted for a reason other than the position being healthy.
   */
  unscanned: number;
  /** The reverts that were not a healthy position, grouped for the log. */
  faults: FaultTally;
}

/**
 * Sort each probe into an answer or a gap. `probes[i]` belongs to `candidates[i]`.
 *
 * A healthy position is the lens answering the question, and it is most of the table on every
 * cycle. Every other revert is the deployment failing to answer it, so it is a gap like a batch
 * that never ran: "probed and could not tell" and "never probed" are not answers a liquidator can
 * act on differently.
 */
export function summarizeProbes<C, T>(
  candidates: readonly C[],
  probes: readonly ChunkedProbe<T>[]
): ProbeSummary<C, T> {
  if (probes.length !== candidates.length) {
    throw new Error(`${probes.length} probe(s) for ${candidates.length} candidate(s)`);
  }

  const succeeded: { candidate: C; value: T }[] = [];
  const faults = new FaultTally();
  let unprobed = 0;
  probes.forEach((probe, i) => {
    if (probe.status === "success")
      succeeded.push({ candidate: candidates[i], value: probe.value });
    else if (probe.status === "unscanned") unprobed += 1;
    else if (!isHealthyPositionRevert(probe.error)) faults.record(probe.error);
  });

  const unscanned = unprobed + faults.count;
  return { succeeded, checked: candidates.length - unscanned, unscanned, faults };
}
