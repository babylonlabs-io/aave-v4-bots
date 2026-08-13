/**
 * Batching for the live contract probes the API runs over every indexed row.
 *
 * Kept apart from the route handler because the handler imports Ponder's virtual `ponder:api`
 * module and cannot be loaded outside a running indexer — this is the part worth testing.
 */

/**
 * Items per batch, so one batch's gas stays well inside any node's `eth_call` cap.
 *
 * A multicall's `allowFailure: true` makes a *sub-call* revert harmless — the normal case for these
 * probes, since a healthy position reverts by design. It does nothing for the envelope: the
 * aggregate is still one `eth_call`, and once its total gas passes the node's cap the whole call
 * reverts and every result is lost, healthy and liquidatable alike.
 *
 * That ceiling is reached by growth, not only by an attacker. A position row is created on any
 * `Spoke:Supply` and removed only when its shares reach zero, so the table is monotonic in practice
 * and the scan gets heavier every cycle.
 *
 * 25 is measured, not guessed. One probe of a *healthy* position costs ~177k gas against a
 * five-reserve spoke, and healthy is the case that sets the price: `estimateLiquidation` loads
 * every reserve before it finds out the position is healthy and reverts, and the table is almost
 * all healthy positions. Batching does not amortise it — the marginal cost stays ~177k however
 * large the batch — so 25 is ~4.4M gas, inside both the 50M `rpc.gascap` geth defaults to and the
 * 10M some providers enforce.
 *
 * The margin is not padding. The per-probe cost rises ~21k per spoke reserve the deployment lists
 * and ~3k per vault backing a position, and a position that really is liquidatable costs ~247k
 * rather than ~177k — so a distressed market on a deployment with more loan assets runs to roughly
 * twice today's number. Raise `POSITION_PROBE_CHUNK_SIZE` only against a known node cap.
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
