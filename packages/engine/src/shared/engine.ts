import type { Address, PublicClient } from "viem";

import { type TokenMeta, TokenMetaCache, readBalance } from "@repo/chain";
import type { ExecutionIdentity } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type RiskGate, type RiskSlot, settleUnfinished } from "@repo/risk";
import type { Executor } from "./executor";
import type { Indexer } from "./indexer";

/**
 * The cycle-level metrics every engine reports, whatever else it measures. `BaseEngine` is generic
 * over the full metric type rather than narrowing to this one, so a strategy keeps its own
 * `recordVaultAcquired` / `recordPositionsChecked` on `this.metrics`.
 */
export interface CycleMetrics {
  recordError(type: string): void;
  recordPollDuration(durationMs: number): void;
}

/**
 * The collaborators every engine holds, as opposed to the addresses and bounds each strategy
 * configures for itself (those stay in the per-engine `*EngineParams`, which the services' `Config`
 * interfaces extend directly).
 */
export interface BaseEngineConfig<M extends CycleMetrics> {
  publicClient: PublicClient;
  /**
   * The one indexer for the process: the reads, and the liveness verdict that says whether to
   * trust them. Shared with every other engine, so a single incident is one incident.
   */
  indexer: Indexer;
  metrics: M;
  logger: Logger;
  risk: RiskGate;
  /**
   * The execution-mode seam and an engine's sole execution collaborator: how each action is
   * committed (AUTO sign+broadcast vs keyless MANUAL propose+notify), plus who the txs come from
   * (`executor.identity`). The composition root (`@repo/runtime`) builds it — an `AutoExecutor`
   * wrapping the wallet + shared nonce authority, or a keyless `ManualExecutor` — and injects it,
   * so an engine holds no `WalletClient`, `TxSender`, or nonce state of its own. Both engines
   * the arbitrageur runs share one instance, so they never collide on a nonce.
   */
  executor: Executor;
  /**
   * Fired once per completed cycle, however it ended. Feeds the health server's liveness stamp.
   *
   * Engine-owned rather than left to each poll loop, for the same reason `recordPollDuration` is:
   * a composition root that forgot it would leave `/health` reporting a `lastPollAt` that never
   * moves, which reads as a wedged bot.
   */
  onPollComplete?: () => void;
}

/**
 * The poll-cycle lifecycle both engines run: the guards before the work, and the bookkeeping after
 * it, whatever happens in between. Subclasses supply only `poll()` — the strategy.
 *
 * These steps are the same for the liquidation and arbitrage engines because they are properties of
 * *polling with a shared signer against a shared indexer*, not of either strategy. Written out twice
 * they kept drifting apart — a differently-spelled error label, a poll timestamp one engine stamped
 * and the other left to its service loop, and the reconcile/indexer ordering below, which is
 * load-bearing. Each divergence was invisible until an operator saw one bot's dashboard behave
 * unlike the other's, so `run()` is `final` in spirit: override `poll`, never the cycle.
 *
 * What this class must **not** grow into: candidate fetching, balance refreshes, simulation, gas
 * estimation, send batching, receipt classification, funding or allowance behaviour. Those differ
 * per strategy, and a shared parent that accumulates them becomes the thing every future "one more
 * shared helper" is dropped into.
 */
export abstract class BaseEngine<M extends CycleMetrics> {
  protected metrics: M;
  protected logger: Logger;
  protected risk: RiskGate;
  /** The engine's one execution collaborator (see `executor.ts`). Engines reach nothing lower. */
  protected executor: Executor;
  protected publicClient: PublicClient;
  protected indexer: Indexer;
  /**
   * ERC-20 symbol/decimals are immutable per address, so each is read once per engine rather than
   * once per cycle. Protected because the liquidation engine hands it to its funding mode, which
   * resolves the same tokens.
   */
  protected tokenMetaCache = new TokenMetaCache();
  private onPollComplete?: () => void;
  /** Names this engine in the cycle's own log lines. */
  private readonly engineName: string;
  /**
   * The action name this engine's intents are recorded under.
   *
   * Deliberately separate from `engineName`, which only labels log lines: this string is part of
   * the persisted idempotency key `(chainId, target, action, subject)` and the filter `reconcile`
   * sweeps by, so changing it orphans every in-flight intent already in the store. The arbitrage
   * engine's is `vault-acquisition`, not `arbitrage`, and must stay that way.
   *
   * Protected because the same string has to appear on the risk action and on the committed
   * intent; reading it from here is what keeps those three in agreement.
   */
  protected readonly intentAction: string;

  constructor(config: BaseEngineConfig<M>, names: { engine: string; intentAction: string }) {
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.risk = config.risk;
    this.publicClient = config.publicClient;
    this.indexer = config.indexer;
    this.executor = config.executor;
    this.onPollComplete = config.onPollComplete;
    this.engineName = names.engine;
    this.intentAction = names.intentAction;
    // Nothing abstract may be called from here: a subclass's own fields are not assigned until
    // this constructor returns.
  }

  /** Who these txs come from — the executor's identity (the signer in AUTO, the operator in MANUAL). */
  protected get identity(): ExecutionIdentity {
    return this.executor.identity;
  }

  /** Resolve a token's symbol/decimals via this engine's cached reader. */
  protected tokenMeta(token: Address): Promise<TokenMeta> {
    return this.tokenMetaCache.get(this.publicClient, token);
  }

  /**
   * This engine's own spendable balance of `token` — the identity every send pays from.
   *
   * Unwrapped by retry: the RPC transport already retries, so wrapping here would stack a second
   * schedule on top of viem's and re-issue calls that failed deterministically, which viem's own
   * predicate declines to do.
   */
  protected readOwnBalance(token: Address): Promise<bigint> {
    return readBalance(this.publicClient, token, this.identity.from);
  }

  /**
   * Resolve this engine's in-flight intents against the chain — the crash- and ambiguous-send-safety
   * step, run at the top of every cycle so an intent left live by a send error is resolved by its
   * reserved nonce vs. the chain (mempool ⇒ hold; mined ⇒ re-drive on settled state; not-broadcast
   * ⇒ re-drive). No-op without a store.
   *
   * Public because services also run it once at boot, before the first cycle.
   */
  async reconcile(): Promise<void> {
    await this.executor.reconcile();
  }

  /**
   * One cycle's strategy: everything between the guards and the bookkeeping.
   *
   * `slots` is the cycle's slot array to push every exposure slot opened onto — `run()` releases
   * any left unsettled. Returning early ends the cycle normally; throwing is caught and counted,
   * because a poll loop that dies on one bad cycle stops trading entirely.
   */
  protected abstract poll(slots: RiskSlot[]): Promise<void>;

  /** Run one poll cycle. */
  async run(): Promise<void> {
    const startTime = Date.now();
    // Every exposure slot this cycle opens. The `finally` releases any `poll` missed, so an
    // unexpected throw can never leak a slot and permanently shrink the exposure cap.
    const slots: RiskSlot[] = [];

    try {
      // A HALTED gate (kill switch or tripped breaker) skips the cycle — before reconcile, so the
      // stop is immediate and touches nothing.
      if (this.risk.state() === "HALTED") {
        this.logger.warn(`Risk gate is HALTED — skipping ${this.engineName} run`);
        return;
      }

      // Crash-/ambiguous-send-safety: resolve in-flight intents against the chain (no-op without a
      // store), then re-seed the shared nonce lease from the chain (reclaiming any
      // reserved-but-not-broadcast nonce).
      await this.reconcile();
      await this.executor.resyncNonces();

      // Only now the indexer, and deliberately *after* reconcile: the candidate list is what a
      // wedged indexer poisons, but an action stranded as a live intent still has to be resolved in
      // a cycle we skip — that is the whole reason reconcile runs before the fetch.
      if (!(await this.indexer.ok())) return;

      await this.poll(slots);
    } catch (error) {
      this.metrics.recordError("poll_error");
      this.logger.error(`${this.engineName} run failed:`, error);
    } finally {
      settleUnfinished(slots);
      this.metrics.recordPollDuration(Date.now() - startTime);
      this.onPollComplete?.();
    }
  }
}
