/**
 * Batching for the live `previewEscrowedVaults` reads the `/escrowed-vaults` route runs over every
 * indexed vault.
 *
 * Kept apart from the route handler because the handler imports Ponder's virtual `ponder:api`
 * module and cannot be loaded outside a running indexer — this is the part worth testing.
 */

import { isVaultGoneRevert } from "./probeFaults";
import { PROBE_CHUNK_SIZE } from "./probePositions";

export interface VaultPreviews<T> {
  /** One preview per vault that answered, in input order. */
  previews: T[];
  /** Vaults that left escrow after the index read. */
  gone: number;
  /** Vaults whose read failed for any other reason. */
  failures: { vaultId: string; error: unknown }[];
  /** The first chunk failure that sent a chunk to per-vault reads. */
  batchError?: unknown;
}

/**
 * Preview `vaultIds` one chunk at a time.
 *
 * `previewEscrowedVaults` reverts the whole call if any one vault has left escrow, and the
 * indexer's lag makes that routine. A chunk that fails is read again one vault per call, so a
 * departed vault costs only its own chunk, and at most `chunkSize` reads are in flight at once.
 */
export async function previewInChunks<I extends string, T>(
  vaultIds: readonly I[],
  preview: (ids: readonly I[]) => Promise<readonly T[]>,
  chunkSize: number = PROBE_CHUNK_SIZE
): Promise<VaultPreviews<T>> {
  const out: VaultPreviews<T> = { previews: [], gone: 0, failures: [] };

  for (let offset = 0; offset < vaultIds.length; offset += chunkSize) {
    const chunk = vaultIds.slice(offset, offset + chunkSize);
    try {
      const results = await preview(chunk);
      // A short or long batch would pair one vault's preview with another's id.
      if (results.length !== chunk.length) {
        throw new Error(`batch returned ${results.length} result(s) for ${chunk.length} vault(s)`);
      }
      out.previews.push(...results);
      continue;
    } catch (error) {
      out.batchError ??= error;
    }

    const settled = await Promise.allSettled(chunk.map((id) => preview([id])));
    settled.forEach((result, i) => {
      if (result.status === "fulfilled" && result.value.length > 0) {
        out.previews.push(result.value[0]);
      } else if (result.status === "rejected" && isVaultGoneRevert(result.reason)) {
        out.gone += 1;
      } else {
        const error = result.status === "rejected" ? result.reason : "empty response";
        out.failures.push({ vaultId: chunk[i], error });
      }
    });
  }

  return out;
}
