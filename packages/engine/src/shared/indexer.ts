import type { RetryConfig } from "@repo/chain";
import type { Logger } from "@repo/logger";
import type { RiskGate } from "@repo/risk";
import { type IndexerClient, createIndexerClient } from "./indexerClient";

/**
 * Is the indexer far enough behind the chain that its answers cannot be trusted?
 *
 * The engines read their candidates from Ponder, which is an unguarded source of truth: a wedged
 * indexer answers `200` with a stale or empty list, and that is indistinguishable from "nothing to
 * do right now". It is worse than silent — the stale list still names positions somebody else has
 * already liquidated, so the bot spends gas on transactions that revert and feeds its own breaker.
 *
 * This is **not** the same question as `RISK_MAX_DATA_STALENESS_MS`. That guard asks whether the
 * *enriched* data on a candidate is old (the block the API's live reads were evaluated at). This
 * one asks whether the candidate **list itself** is complete. An indexer can be perfectly current
 * on the reads it does while being thousands of blocks behind on the events that decide who is even
 * a candidate.
 */

/** Ponder's `/status`, narrowed to the one chain we trade on. */
export interface IndexerStatus {
  blockNumber: bigint;
  blockTimestampMs: number;
}

/**
 * The shape Ponder serves at `/status`, keyed by the chain *name* from its config.
 *
 * The name is a label we do not control, so entries are matched on `id` instead.
 */
type PonderStatusResponse = Record<
  string,
  { id: number; block: { number: number; timestamp: number } }
>;

export type LagVerdict =
  | { kind: "ok"; lagBlocks: bigint }
  | { kind: "lagging"; lagBlocks: bigint; reason: string }
  | { kind: "unknown"; reason: string };

/**
 * Pull our chain's entry out of a `/status` body.
 *
 * `undefined` means the chain is absent — nothing indexed yet, which is a real state during
 * backfill. Two entries for one id is a misconfiguration rather than something to pick between, so
 * it throws instead of guessing.
 */
export function selectChainStatus(
  body: PonderStatusResponse,
  chainId: number
): IndexerStatus | undefined {
  const matches = Object.values(body).filter((entry) => Number(entry?.id) === chainId);
  if (matches.length > 1) {
    throw new Error(`indexer /status reports ${matches.length} entries for chain ${chainId}`);
  }
  const match = matches[0];
  if (match === undefined) return undefined;
  return {
    blockNumber: BigInt(match.block.number),
    blockTimestampMs: Number(match.block.timestamp) * 1000,
  };
}

/**
 * Judge one reading. Pure, so the policy is testable without a server.
 *
 * Lag is measured in **blocks**, not in seconds since the last indexed block. Time would conflate
 * two unrelated incidents: a chain that has stopped producing blocks makes a perfectly caught-up
 * indexer look thousands of seconds stale. Block lag isolates indexer health from chain health, and
 * chain liveness is already what the freshness guard covers.
 */
export function assessIndexerLag(
  status: IndexerStatus | undefined,
  rpcHead: bigint,
  maxLagBlocks: bigint
): LagVerdict {
  if (status === undefined) {
    return { kind: "unknown", reason: "indexer reports no progress for this chain" };
  }
  // A head *ahead* of ours is not lag: our RPC can trail the indexer's between reads. Clamp rather
  // than report a negative, which would read as absurd in a metric.
  const lagBlocks = rpcHead > status.blockNumber ? rpcHead - status.blockNumber : 0n;
  if (lagBlocks > maxLagBlocks) {
    return {
      kind: "lagging",
      lagBlocks,
      reason: `indexer is ${lagBlocks} blocks behind the chain (limit ${maxLagBlocks})`,
    };
  }
  return { kind: "ok", lagBlocks };
}

/** What the guard reports through. Process-level, so it carries no engine's prefix. */
export interface IndexerMetrics {
  recordLag(lagBlocks: number): void;
  recordCycleSkipped(): void;
  recordHalt(): void;
}

export interface IndexerGuardConfig {
  /** Skip the cycle beyond this lag. Unset ⇒ the guard is off entirely. */
  maxLagBlocks?: bigint;
  /**
   * How long the indexer may stay continuously unusable before the gate is halted.
   *
   * A *duration*, not a number of checks. Counting checks would make the threshold depend on how
   * many engines happen to be running and how fast each polls: the arbitrageur's two loops tick at
   * different intervals against one indexer, so a call counter advances at their combined rate and
   * "5 checks" would mean something different in every deployment. A duration means the same thing
   * everywhere, and is what an operator actually wants to express.
   */
  haltAfterMs: number;
}

export interface IndexerDeps {
  /** Base URL and the process's retry policy — the underlying client is built from these. */
  baseUrl: string;
  retry?: Partial<RetryConfig>;
  chainId: number;
  getRpcHead: () => Promise<bigint>;
  risk: RiskGate;
  logger: Logger;
  metrics: IndexerMetrics;
  config: IndexerGuardConfig;
  now?: () => number;
}

/**
 * Everything an engine needs from the indexer: what it says, and whether to believe it.
 *
 * One object rather than a client plus a separate guard, because an engine never wants one without
 * the other — and because the guard already depends on the client, so composing this way collapses
 * a wrapper into its wrappee without inverting a dependency. The reverse (a client owning the
 * guard) would drag a risk gate, a logger, metrics and a clock into a thing whose job is fetching
 * JSON.
 *
 * Note what is deliberately *not* done: `read` is not itself guarded. It cannot be — `ok()` learns
 * the indexer's head by reading `/status` through this same client, so a guarded `read` would
 * re-enter the guard on every check.
 */
export interface Indexer extends IndexerClient {
  /**
   * May the caller act on what the indexer says right now?
   *
   * `false` means skip the cycle — it does **not** mean halt. Catching up after a reorg or an RPC
   * hiccup is transient and must not stop production; only a sustained run of bad checks halts.
   *
   * Always present, and `true` when the guard is unconfigured, so no caller has to ask whether
   * checking is switched on.
   */
  ok(): Promise<boolean>;
}

/**
 * One guard per process, shared by every engine reading the same indexer.
 *
 * Sharing is load-bearing, not tidiness. The arbitrageur runs two poll loops against a *single*
 * Ponder; if each kept its own consecutive-bad-check count, one indexer incident would be counted
 * twice and the halt would fire at half the configured threshold. The thing being judged is the
 * indexer, not the engine asking.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const { chainId, getRpcHead, risk, logger, metrics, config } = deps;
  const client = createIndexerClient({ baseUrl: deps.baseUrl, retry: deps.retry });
  const now = deps.now ?? Date.now;
  /** When the current unusable streak began; `undefined` while the indexer is healthy. */
  let unusableSince: number | undefined;
  /** So a streak halts once, rather than on every check after it crosses the threshold. */
  let halted = false;

  const bad = (reason: string): boolean => {
    const at = now();
    if (unusableSince === undefined) unusableSince = at;
    metrics.recordCycleSkipped();

    const unusableMs = at - unusableSince;
    if (!halted && unusableMs >= config.haltAfterMs) {
      halted = true;
      metrics.recordHalt();
      risk.halt(`indexer unusable for ${unusableMs}ms: ${reason}`);
      return false;
    }
    logger.warn(
      `Indexer unusable for ${unusableMs}ms (halt at ${config.haltAfterMs}ms): ${reason}`
    );
    return false;
  };

  return {
    ...client,

    async ok(): Promise<boolean> {
      const { maxLagBlocks } = config;
      if (maxLagBlocks === undefined) return true;

      let verdict: LagVerdict;
      try {
        const [body, rpcHead] = await Promise.all([
          client.read<PonderStatusResponse>("/status"),
          getRpcHead(),
        ]);
        verdict = assessIndexerLag(selectChainStatus(body, chainId), rpcHead, maxLagBlocks);
      } catch (error) {
        // Lag unknown is not lag zero: a `/status` we cannot read tells us nothing about the list we
        // are about to trade on. Fail closed, as the freshness guard does.
        return bad(
          `could not read indexer status: ${error instanceof Error ? error.message : error}`
        );
      }

      if (verdict.kind !== "ok") {
        if (verdict.kind === "lagging") metrics.recordLag(Number(verdict.lagBlocks));
        return bad(verdict.reason);
      }

      metrics.recordLag(Number(verdict.lagBlocks));
      unusableSince = undefined;
      halted = false;
      return true;
    },
  };
}
