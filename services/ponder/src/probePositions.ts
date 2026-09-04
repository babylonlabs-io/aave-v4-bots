/**
 * Batching for the live contract probes the API runs over every indexed row.
 *
 * Kept apart from the route handler because the handler imports Ponder's virtual `ponder:api`
 * module and cannot be loaded outside a running indexer — this is the part worth testing.
 */

/** Calldata of one `estimateLiquidation(address,bool)`: a selector and two words. */
const ESTIMATE_CALLDATA_BYTES = 68;

/**
 * Probes per `eth_call`, and the figure that actually decides one call's gas.
 *
 * Not `PROBE_CHUNK_SIZE`: viem's `multicall` splits a batch by **calldata bytes** (`batchSize`,
 * 1024 by default) and fires the pieces concurrently, so a chunk handed to it is not one `eth_call`
 * unless it happens to fit. The route pins `batchSize` to this many probes so the size of a call is
 * a decision here rather than a default nobody stated.
 *
 * 15 is measured, not guessed. One probe of a *healthy* position costs ~177k gas against a
 * five-reserve spoke, and healthy is the case that sets the price: `estimateLiquidation` loads every
 * reserve before it finds out the position is healthy and reverts, and the table is almost all
 * healthy positions. Batching does not amortise it — the marginal cost stays ~177k however large the
 * batch — so 15 is ~2.7M gas, inside both the 50M `rpc.gascap` geth defaults to and the 10M some
 * providers enforce.
 *
 * The margin is not padding. The per-probe cost rises ~21k per spoke reserve the deployment lists
 * and ~3k per vault backing a position, and a position that really is liquidatable costs ~247k
 * rather than ~177k — so a distressed market on a deployment with more loan assets runs to roughly
 * twice today's number.
 */
export const PROBES_PER_CALL = 15;

/** `PROBES_PER_CALL` as viem's `multicall` wants it: a calldata-byte limit. */
export const MULTICALL_BATCH_BYTES = PROBES_PER_CALL * ESTIMATE_CALLDATA_BYTES;

/**
 * Items per chunk — which is how many `eth_call`s run **concurrently**, not how big one is.
 *
 * A chunk is handed to `multicall`, which splits it into `PROBES_PER_CALL`-sized calls and awaits
 * them together, and `probeInChunks` awaits one chunk before starting the next. So the chunk size is
 * the width of a wave: 25 is two calls in flight (15 and 10), 45 would be three. Per-call gas does
 * not move with it. A multiple of `PROBES_PER_CALL` makes the calls in a wave even.
 *
 * Raising it buys latency on a large table and spends RPC concurrency to do it — the indexer is
 * competing with its own event ingestion for the same endpoint, and a provider that throttles will
 * fail whole chunks, which cost their positions this cycle (`unscanned`).
 *
 * A batch that fails as a whole is survivable; what is not is one oversized call taking every result
 * with it. `allowFailure: true` makes a *sub-call* revert harmless — the normal case here, since a
 * healthy position reverts by design — but it does nothing for the envelope: past the node's cap the
 * whole `eth_call` reverts and healthy and liquidatable results are lost alike. That is what
 * `PROBES_PER_CALL` bounds.
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

export interface ChunkedProbes<T> {
  /** Exactly one entry per input item, in input order — callers index positions by this. */
  probes: Probe<T>[];
  /** Items whose probe never ran because their batch failed as a whole. */
  unscanned: number;
}

/**
 * Run `runChunk` over `items` in batches of `chunkSize`, surviving a batch that fails as a whole.
 *
 * A thrown batch costs its own items this cycle and nothing more: they come back as failures and
 * are counted in `unscanned`. That distinction is the point — folding them into "probe reverted"
 * would make a partial scan indistinguishable from a quiet market, and "no candidates" is the one
 * answer a liquidator must never infer from a failure.
 *
 * `runChunk` must return one result per item it was given. A short or long batch would shift every
 * later probe against its item, attributing one position's estimate to another's proxy, so it is
 * rejected as a batch failure rather than trusted.
 */
export async function probeInChunks<I, T>(
  items: readonly I[],
  runChunk: (chunk: readonly I[], offset: number) => Promise<Probe<T>[]>,
  onChunkFailure: (offset: number, size: number, error: unknown) => void,
  chunkSize: number = PROBE_CHUNK_SIZE
): Promise<ChunkedProbes<T>> {
  const probes: Probe<T>[] = [];
  let unscanned = 0;

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    try {
      const results = await runChunk(chunk, offset);
      if (results.length !== chunk.length) {
        throw new Error(`batch returned ${results.length} result(s) for ${chunk.length} item(s)`);
      }
      probes.push(...results);
    } catch (error) {
      unscanned += chunk.length;
      probes.push(...chunk.map((): Probe<T> => ({ status: "failure", error })));
      onChunkFailure(offset, chunk.length, error);
    }
  }

  return { probes, unscanned };
}

/**
 * Pair every position with the borrower that owns its proxy, dropping the ones that have none.
 *
 * A `position` row is created for the `user` of any `Spoke:Supply`, and that argument is the
 * supplier's to choose — so the table holds addresses that are not adapter proxies at all, and
 * anyone can add more of them for the price of a dust supply. Such a row has no borrower, so there
 * is no `liquidate` call to build from it whatever a probe would say about it. Probing one is not
 * cheap either: `estimateLiquidation` loads every reserve before it reaches the proxy, so an address
 * that was never a proxy costs nearly as much as a real position. Dropping them before the scan is
 * what keeps that cost out of it.
 *
 * Addresses are matched case-insensitively: the two tables are populated from different events and
 * nothing guarantees they agree on checksumming.
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
