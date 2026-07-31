import { type Address, type Hex, type PublicClient, formatUnits } from "viem";

import { adapterAbi, lensAbi, spokeAbi } from "@repo/abis";
import { type RetryConfig, TokenMetaCache, fetchJsonWithRetry, readBalance } from "@repo/chain";
import type { ContractCall, ExecutionIdentity } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type RiskGate, type RiskSlot, settleUnfinished } from "@repo/risk";
import type { Executor } from "../executor";
import { bufferAmounts } from "./domain";
import {
  type FundedCandidate,
  type FundingParams,
  type LiquidationCandidate,
  type LiquidationFunding,
  createLiquidationFunding,
} from "./funding";
import { discoverBorrowableReserves } from "./reserves";
import type { LiquidatablePosition, PonderResponse } from "./types";

const DEFAULT_FETCH_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

/** Observability port — the engine reports through it; the service supplies metrics. */
export interface LiquidationMetrics {
  recordError(type: string): void;
  recordLiquidationSuccess(): void;
  recordLiquidationFailed(): void;
  recordSimulationFailed(): void;
  recordPollDuration(durationMs: number): void;
  recordPositionsChecked(count: number): void;
  recordPositionsLiquidatable(count: number): void;
  recordTokenBalance(symbol: string, address: Address, balance: bigint, decimals: number): void;
}

/**
 * Domain parameters the liquidation pipeline operates on — the env-derivable
 * subset shared by the engine config and the service's own config (no runtime
 * deps like clients or metrics). Services extend this so the fields are declared
 * once, here, next to the engine that consumes them.
 */
export interface LiquidationEngineParams {
  adapterAddress: Address;
  lensAddress: Address;
  wbtcAddress: Address;
  /** Override auto-discovered debt tokens from the Spoke. */
  debtTokenAddresses?: Address[];
  /** BTC redeem key; bytes32(0) means WBTC payout via VaultSwap. */
  btcRedeemKey: Hex;
  /** Direct BTC redemption vs WBTC payout via VaultSwap. */
  isDirectRedemption: boolean;
  /** VaultSwap (LLP) address, used for non-direct redemption. */
  llpAddress: Address;
  ponderUrl: string;
  txReceiptTimeoutMs: number;
  /**
   * How repayment is funded.
   *
   * `inventory` (default) pays out of the signer's own inventory, which is why every candidate
   * declares a `spend` vector to the risk gate. `flash` routes through `LiquidationRouter`, which
   * borrows each debt token from a venue and repays itself out of the seized collateral — the
   * signer spends only gas, and needs no debt-token inventory at all.
   */
  funding?: FundingParams;
}

export interface LiquidationEngineConfig extends LiquidationEngineParams {
  publicClient: PublicClient;
  metrics: LiquidationMetrics;
  logger: Logger;
  risk: RiskGate;
  /**
   * The execution-mode seam and the engine's sole execution collaborator: how each action is
   * committed (AUTO sign+broadcast vs keyless MANUAL propose+notify), plus who the txs come from
   * (`executor.identity`). The composition root (`@repo/runtime`) builds it — an `AutoExecutor`
   * wrapping the wallet + shared nonce authority, or a keyless `ManualExecutor` — and injects it, so
   * the engine holds no `WalletClient`, `TxSender`, or nonce state of its own.
   */
  executor: Executor;
}

export class LiquidationEngine {
  private metrics: LiquidationMetrics;
  private logger: Logger;
  private risk: RiskGate;
  /** The engine's one execution collaborator (see `executor.ts`). The engine reaches nothing lower. */
  private executor: Executor;
  private publicClient: PublicClient;
  private adapterAddress: Address;
  private lensAddress: Address;
  private debtTokenAddresses: Address[];
  private wbtcAddress: Address;
  private btcRedeemKey: Hex;
  private isDirectRedemption: boolean;
  private llpAddress: Address;
  private ponderUrl: string;
  private txReceiptTimeoutMs: number;
  /** How repayment is funded — the seam that decides the call, the risk declaration and the setup. */
  private funding: LiquidationFunding;
  private tokenMetaCache = new TokenMetaCache();

  /** Who these txs come from — the executor's identity (the signer in AUTO, the operator in MANUAL). */
  private get identity(): ExecutionIdentity {
    return this.executor.identity;
  }

  constructor(config: LiquidationEngineConfig) {
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.risk = config.risk;
    this.publicClient = config.publicClient;
    this.adapterAddress = config.adapterAddress;
    this.lensAddress = config.lensAddress;
    this.debtTokenAddresses = config.debtTokenAddresses ?? [];
    this.wbtcAddress = config.wbtcAddress;
    this.btcRedeemKey = config.btcRedeemKey;
    this.isDirectRedemption = config.isDirectRedemption;
    this.llpAddress = config.llpAddress;
    this.ponderUrl = config.ponderUrl;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs;
    this.executor = config.executor;
    // The config already carries every collaborator a strategy needs, so it is spread in rather
    // than re-listed field by field. Only these two cannot come from it: the debt-token list is
    // discovered later (during `prepare()`), and the token cache is shared with this engine so a
    // symbol is read once per process.
    this.funding = createLiquidationFunding(config.funding ?? { mode: "inventory" }, {
      ...config,
      debtTokens: () => this.debtTokenAddresses,
      tokenMeta: this.tokenMetaCache,
    });
  }

  /**
   * Boot-time setup: discover the debt tokens, then let the funding mode prepare itself.
   *
   * One call so a service never has to know which setup its funding mode needs: inventory funding
   * approves the adapter, flash funding approves nothing.
   */
  async prepare(): Promise<void> {
    if (this.debtTokenAddresses.length === 0) await this.discoverDebtTokens();
    await this.funding.prepare();
  }

  /** Resolve a token's symbol/decimals via the shared, cached reader. */
  private getTokenMeta(tokenAddress: Address) {
    return this.tokenMetaCache.get(this.publicClient, tokenAddress);
  }

  /**
   * Whether the position has been fully liquidated — i.e. another liquidator got there first. Used
   * only to classify a reverted liquidation. `getPosition` returns a value, so a genuine RPC failure
   * throws and is caught as `false` (position still there ⇒ treat the revert as a real failure).
   * Failing toward "not a lost race" is deliberate: a blip must never exempt a real failure from the
   * breaker. Only a *full* clear (collateral 0) counts as taken; a partial competitor liquidation
   * leaves collateral and is treated conservatively as our failure.
   */
  private async wasPositionTaken(borrower: Address): Promise<boolean> {
    try {
      const position = await this.publicClient.readContract({
        address: this.adapterAddress,
        abi: adapterAbi,
        functionName: "getPosition",
        args: [borrower],
      });
      return position.totalCollateralBTC === 0n;
    } catch {
      return false;
    }
  }

  /**
   * Discover debt tokens from the Spoke contract's borrowable reserves.
   * Reads Spoke address from the AaveAdapter, then enumerates reserves.
   */
  async discoverDebtTokens(): Promise<void> {
    this.debtTokenAddresses = await discoverBorrowableReserves({
      publicClient: this.publicClient,
      adapterAddress: this.adapterAddress,
      logger: this.logger,
      tokenSymbol: async (token) => (await this.getTokenMeta(token)).symbol,
    });
  }

  /**
   * Resolve this engine's in-flight `liquidation` intents against the chain — the crash- and
   * ambiguous-send-safety step. Run **every cycle** (start of `run()`) so an intent left live
   * by a send error is resolved by its reserved nonce vs. the chain (mempool ⇒ hold; mined ⇒
   * re-drive on settled state; not-broadcast ⇒ re-drive). No-op without a store.
   */
  async reconcile(): Promise<void> {
    await this.executor.reconcile("liquidation");
  }

  /**
   * Run one iteration of the liquidation bot.
   * For each position: estimate via Lens, simulate, then execute.
   */
  async run(): Promise<void> {
    const startTime = Date.now();
    // Every exposure slot this cycle opens. The `finally` releases any the code below missed,
    // so an unexpected throw can never leak a slot and wedge the exposure cap.
    const slots: RiskSlot[] = [];

    try {
      // Risk gate — a HALTED gate (kill-switch or tripped breaker) skips the cycle.
      if (this.risk.state() === "HALTED") {
        this.logger.warn("Risk gate is HALTED — skipping liquidation run");
        return;
      }

      // Crash-/ambiguous-send-safety: resolve in-flight intents against the chain (no-op
      // without a store), then re-seed the shared nonce lease from the chain (reclaiming any
      // reserved-but-not-broadcast nonce). Done before fetching so a position stuck as a live
      // intent is resolved even in a cycle that would otherwise skip it.
      await this.reconcile();
      await this.executor.resyncNonces();

      // Publish spendable balances to the gate before judging any candidate. The gate reserves each
      // action's declared spend against these, which is what stops this engine and the arbitrage
      // engine — same signer, same WBTC — from both committing the same balance. A read failure
      // propagates to the cycle's catch: unable to price our own inventory, we do not trade.
      await this.funding.refreshInventory();

      // Fetch liquidatable positions from Ponder (with the freshness stamp of its reads)
      const { positions, dataTimestampMs } = await this.fetchLiquidatablePositions();

      this.metrics.recordPositionsLiquidatable(positions.length);

      if (positions.length === 0) {
        this.logger.info("No liquidatable positions found");
        return;
      }

      this.logger.info(`Found ${positions.length} liquidatable position(s)`);

      // Estimate liquidation inputs via Lens for each position
      const estimateResults = await Promise.allSettled(
        positions.map((p) =>
          this.publicClient.readContract({
            address: this.lensAddress,
            abi: lensAbi,
            functionName: "estimateLiquidation",
            args: [p.proxyAddress, this.isDirectRedemption],
          })
        )
      );

      // Build position + amounts pairs, filter failed estimates
      const candidates: LiquidationCandidate[] = [];

      for (let i = 0; i < estimateResults.length; i++) {
        const result = estimateResults[i];
        const pos = positions[i];

        if (result.status === "fulfilled") {
          const [amounts, wbtcPayment] = result.value;
          // Buffer each amount (default 1%) to cover interest accrual between the Lens read and
          // execution. `wbtcPayment` (fairness top-up +, in direct-redemption mode, the redemption fee) is
          // pulled from msg.sender by the adapter, so it is a real outflow even though it is not
          // threaded into the call — it is carried here to be declared to the risk gate, which
          // reserves it against the WBTC the arbitrage engine is spending from the same signer.
          // Already mode-correct: the Lens was asked with `isDirectRedemption`.
          candidates.push({ position: pos, amounts: bufferAmounts(amounts), wbtcPayment });
        } else {
          this.metrics.recordError("lens_estimate_error");
          const reason = result.reason;
          const errorMsg = reason instanceof Error ? reason.message : "Unknown error";
          this.logger.warn(`Lens estimate failed for ${pos.proxyAddress}: ${errorMsg}`);
        }
      }

      if (candidates.length === 0) {
        this.logger.info("No positions passed Lens estimation");
        return;
      }

      // Vet + price. Each mode decides viability its own way and hands back the call to send.
      const validCandidates = await this.funding.vet(candidates);

      if (validCandidates.length === 0) {
        this.logger.info("No positions passed simulation");
        return;
      }

      this.logger.info(`${validCandidates.length}/${positions.length} positions passed simulation`);
      return await this.sendAll(validCandidates, dataTimestampMs, slots);
    } catch (error) {
      this.metrics.recordError("run_error");
      this.logger.error("Liquidation run failed:", error);
    } finally {
      settleUnfinished(slots);
      this.metrics.recordPollDuration(Date.now() - startTime);
    }
  }

  /**
   * Commit every vetted candidate, then await the receipts.
   *
   * `flash` candidates arrive carrying the plan their probe produced; `inventory` ones are priced from
   * the signer's own balances here. The difference is confined to `slot`/`call` below — everything
   * about nonce ownership, intent lifecycle and receipt settlement is shared.
   */
  private async sendAll(
    validCandidates: readonly FundedCandidate[],
    dataTimestampMs: number | undefined,
    slots: RiskSlot[]
  ): Promise<void> {
    try {
      // Send. Every tx routes through the shared nonce allocator (`withNonce`), the single nonce
      // owner across both engines. A send error is treated as AMBIGUOUS (the tx may have
      // propagated): the intent is kept LIVE (never terminal) and the cycle stops — the next
      // cycle's reconcile resolves it by nonce vs. chain.
      // Each sent tx is paired with its intent id (so the receipt phase records its outcome) and its
      // risk slot (so the receipt phase settles the exposure it reserved).
      const sent: Array<{
        hash: Hex;
        intentId?: string;
        slot: RiskSlot;
        position: LiquidatablePosition;
      }> = [];
      sendLoop: for (let i = 0; i < validCandidates.length; i++) {
        const { position, call, risk } = validCandidates[i];

        // Risk gate — per-candidate check just before submit. An allowed check reserves an
        // exposure slot that MUST be settled on every path below (see `RiskSlot`).
        //
        // What gets declared comes from the funding mode, the only thing that can know it: `inventory`
        // names the tokens the tx will pull from the signer and cannot price itself, `flash` prices
        // the action from its probe and moves none of the signer's tokens. The engine stays out of
        // that judgement and owns only the slot's lifecycle.
        const slot = this.risk.openSlot({
          kind: "liquidation",
          subject: position.proxyAddress,
          dataTimestampMs,
          ...risk,
        });
        if (!slot.allowed) {
          this.metrics.recordError("risk_blocked");
          this.logger.warn(`Risk gate blocked ${position.proxyAddress}: ${slot.reason}`);
          continue;
        }
        slots.push(slot);

        // Commit the action through the mode seam. AUTO signs + broadcasts under the shared nonce
        // lock (claim → send → markPending → submitted, all inside `commit`); MANUAL proposes +
        // notifies.
        const out = await this.executor.commit(call, {
          target: call.address,
          action: "liquidation",
          subject: position.proxyAddress,
        });

        switch (out.kind) {
          case "duplicate":
            // A live intent for this subject already exists — nothing broadcast; free the slot.
            slot.settle({ ok: false, abandoned: true });
            this.metrics.recordError("intent_in_flight");
            continue;

          case "proposed":
            // MANUAL — written down for an operator; nothing on chain, no receipt to await.
            slot.settle({ ok: false, abandoned: true });
            continue;

          case "aborted":
            this.metrics.recordError("tx_send_error");
            this.logger.error(`Failed to send liquidation for ${position.borrower}: ${out.error}`);
            // Only a failed *broadcast* is a real failure signal for the breaker; a pre-broadcast
            // failure reached no chain, so an RPC/database blip cannot trip it.
            slot.settle({ ok: false, abandoned: !out.broadcastAttempted });
            // The send left a possible nonce gap — stop the cycle; the next resync reclaims it.
            break sendLoop;

          case "broadcast":
            // The intent is already `submitted` (recorded inside `commit`).
            this.logger.info(`Sent liquidation for ${position.borrower}: ${out.hash}`);
            sent.push({ hash: out.hash, intentId: out.intentId, slot, position });
            continue;

          default:
            out satisfies never; // exhaustiveness — a new `CommitResult` kind must be handled here
        }
      }

      if (sent.length === 0) {
        this.logger.info("No liquidation txs were sent");
        return;
      }

      // Batch-wait for all receipts
      this.logger.info(`Waiting for ${sent.length} liquidation receipt(s)...`);
      const receipts = await Promise.allSettled(
        sent.map(({ hash }) =>
          this.publicClient.waitForTransactionReceipt({ hash, timeout: this.txReceiptTimeoutMs })
        )
      );

      for (let i = 0; i < receipts.length; i++) {
        const result = receipts[i];
        const { hash, intentId, slot, position } = sent[i];
        if (result.status === "fulfilled") {
          const receipt = result.value;
          if (receipt.status === "success") {
            slot.settle({ ok: true });
            this.metrics.recordLiquidationSuccess();
            this.logger.info(`Liquidation confirmed in block ${receipt.blockNumber}: ${hash}`);
            if (intentId)
              await this.executor.recordOutcome(intentId, { kind: "confirmed", txHash: hash });
          } else {
            // A reverted liquidation is only *our* failure if the position is still there to take.
            // If it has been cleared, another liquidator got there first — a lost race, normal
            // competition, which must not feed the breaker (settle `contended`).
            const lostRace = await this.wasPositionTaken(position.borrower);
            if (lostRace) {
              slot.settle({ ok: false, contended: true });
              this.metrics.recordError("race_lost");
              this.logger.info(
                `Position ${position.borrower} already liquidated by another bot — not a failure`
              );
            } else {
              slot.settle({ ok: false });
              this.metrics.recordLiquidationFailed();
              this.metrics.recordError("tx_reverted");
              this.logger.error(`Liquidation reverted: ${hash}`);
            }
            if (intentId)
              await this.executor.recordOutcome(intentId, {
                kind: "failed",
                txHash: hash,
                error: lostRace ? "lost race" : "reverted",
              });
          }
        } else {
          // The receipt never arrived (timeout) or could not be fetched. Either way the tx's fate
          // is UNKNOWN, not failed — it may still be in the mempool, and behind a nonce gap it
          // certainly is. `unresolved` keeps it off the breaker (these arrive in batches, so one
          // shared cause would otherwise land N failures at once and halt a healthy bot) while
          // still counting its declared spend, since the tx may yet land.
          // The intent stays 'submitted' — boot reconcile resolves it against the chain.
          slot.settle({ ok: false, unresolved: true });
          this.metrics.recordError("receipt_fetch_error");
          this.logger.error(`Failed to get receipt for ${hash}: ${result.reason}`);
        }
      }
    } catch (error) {
      this.metrics.recordError("poll_error");
      this.logger.error("Error in bot run:", error);
    } finally {
      settleUnfinished(slots);
    }
  }

  /**
   * Fetch liquidatable positions from Ponder indexer, along with the chain-block timestamp its
   * live reads were evaluated at (the risk gate's freshness input; `undefined` if the indexer
   * doesn't report it).
   */
  private async fetchLiquidatablePositions(): Promise<{
    positions: LiquidatablePosition[];
    dataTimestampMs?: number;
  }> {
    try {
      const data = await fetchJsonWithRetry<PonderResponse>(
        `${this.ponderUrl}/liquidatable-positions`,
        DEFAULT_FETCH_RETRY
      );
      this.metrics.recordPositionsChecked(data.checked);
      return { positions: data.liquidatable, dataTimestampMs: data.dataTimestampMs };
    } catch (error) {
      this.metrics.recordError("ponder_fetch_error");
      this.logger.error("Failed to fetch liquidatable positions:", error);
      return { positions: [] };
    }
  }

  /**
   * Log and record liquidator's token balances (debt tokens + WBTC)
   */
  async logBalances(): Promise<void> {
    const liquidator = this.identity.from;

    // Best-effort: a balance read failing on an RPC blip must not crash the poll
    // loop (mirrors ArbitrageEngine.logBalance). run() has its own try/catch.
    try {
      this.logger.info("Token balances:");

      // Debt tokens — symbol/decimals are immutable, fetched once and cached.
      // Kick metadata + balanceOf in parallel so cold-start matches the original
      // 3-RPC concurrency; subsequent cycles only fire balanceOf (cache hit).
      for (const tokenAddress of this.debtTokenAddresses) {
        const [{ symbol, decimals }, balance] = await Promise.all([
          this.getTokenMeta(tokenAddress),
          readBalance(this.publicClient, tokenAddress, liquidator),
        ]);

        this.metrics.recordTokenBalance(symbol, tokenAddress, balance, decimals);
        this.logger.info(`   ${symbol}: ${formatUnits(balance, decimals)}`);
      }

      // WBTC balance
      const [{ symbol: wbtcSymbol, decimals: wbtcDecimals }, wbtcBalance] = await Promise.all([
        this.getTokenMeta(this.wbtcAddress),
        readBalance(this.publicClient, this.wbtcAddress, liquidator),
      ]);

      this.metrics.recordTokenBalance(wbtcSymbol, this.wbtcAddress, wbtcBalance, wbtcDecimals);
      this.logger.info(`   ${wbtcSymbol}: ${formatUnits(wbtcBalance, wbtcDecimals)}`);
    } catch (error) {
      this.logger.error("Failed to fetch balances:", error);
    }
  }
}
