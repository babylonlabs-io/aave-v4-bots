import { positiveIntSchema } from "./schemas";

/**
 * Indexer-liveness thresholds. Unset ⇒ the guard is off, so a deployment that sets none of these
 * behaves exactly as it did before the guard existed.
 */
export const indexerEnvFields = {
  /**
   * Skip a poll cycle when the indexer is more than this many blocks behind the chain.
   *
   * In blocks rather than seconds on purpose: seconds would conflate a lagging indexer with a
   * chain that has stopped producing, which is a different incident and already covered by
   * `RISK_MAX_DATA_STALENESS_MS`.
   */
  INDEXER_MAX_LAG_BLOCKS: positiveIntSchema.optional(),
  /**
   * How long the indexer may stay continuously unusable before the risk gate halts.
   *
   * A duration, not a count of checks: two engines polling one indexer at different intervals
   * would advance a check counter at their combined rate, so the same number would mean a
   * different thing in every deployment.
   */
  INDEXER_MAX_LAG_HALT_MS: positiveIntSchema.optional().default("60000"),
  /**
   * How long to wait at boot for the indexer to finish backfilling before refusing to start.
   *
   * Unset ⇒ start immediately. Deliberately not defaulted: waiting is a constraint on *startup*,
   * and a deployment whose backfill legitimately runs longer than any default we picked would fail
   * to boot for a reason its operator never chose.
   */
  INDEXER_READY_TIMEOUT_MS: positiveIntSchema.optional(),
} as const;

export interface IndexerSettings {
  indexer: {
    maxLagBlocks?: bigint;
    haltAfterMs: number;
    readyTimeoutMs?: number;
  };
}

export function buildIndexerConfig(env: {
  INDEXER_MAX_LAG_BLOCKS?: string;
  INDEXER_MAX_LAG_HALT_MS: string;
  INDEXER_READY_TIMEOUT_MS?: string;
}): IndexerSettings {
  return {
    indexer: {
      maxLagBlocks:
        env.INDEXER_MAX_LAG_BLOCKS === undefined ? undefined : BigInt(env.INDEXER_MAX_LAG_BLOCKS),
      haltAfterMs: Number.parseInt(env.INDEXER_MAX_LAG_HALT_MS, 10),
      readyTimeoutMs:
        env.INDEXER_READY_TIMEOUT_MS === undefined
          ? undefined
          : Number.parseInt(env.INDEXER_READY_TIMEOUT_MS, 10),
    },
  };
}
