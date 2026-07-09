import {
  type Account,
  type Address,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  formatUnits,
  maxUint256,
} from "viem";

import { adapterAbi, lensAbi, spokeAbi } from "@repo/abis";
import { TokenMetaCache, approveMax, readAllowance, readBalance } from "@repo/capital";
import { type RetryConfig, fetchWithRetry } from "@repo/chain";
import { bufferAmounts, isBorrowableReserve, sequentialPriorityOrder } from "@repo/domain";
import { type NonceAllocator, nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { StateStore } from "@repo/persistence";
import { type RiskGate, type RiskSlot, settleUnfinished } from "@repo/risk";
import {
  bestEffortTransition,
  claimIntent,
  reconcileIntents,
  resyncNonces,
  sendMaybeAllocated,
} from "../crashSafety";
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
}

export interface LiquidationEngineConfig extends LiquidationEngineParams {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  metrics: LiquidationMetrics;
  logger: Logger;
  risk: RiskGate;
  /**
   * Crash-safety store (intent idempotency). When present, each submit is recorded under an
   * idempotency key so a crash/ambiguous-send doesn't double-execute an action; absent ⇒ no
   * intent tracking (behavior-preserving).
   */
  store?: StateStore;
  /**
   * Shared nonce authority. When present, every signer tx routes through it (so the
   * arbitrageur's two engines never collide); absent ⇒ in-memory chain-nonce sequencing
   * (behavior-preserving). Paired with `store` at the composition root.
   */
  nonces?: NonceAllocator;
}

export class LiquidationEngine {
  private metrics: LiquidationMetrics;
  private logger: Logger;
  private risk: RiskGate;
  private store?: StateStore;
  private nonces?: NonceAllocator;
  private walletClient: WalletClient<Transport, Chain, Account>;
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
  private tokenMetaCache = new TokenMetaCache();

  constructor(config: LiquidationEngineConfig) {
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.risk = config.risk;
    this.store = config.store;
    this.nonces = config.nonces;
    this.walletClient = config.walletClient;
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
  }

  /** Resolve a token's symbol/decimals via the shared, cached reader. */
  private getTokenMeta(tokenAddress: Address) {
    return this.tokenMetaCache.get(this.publicClient, tokenAddress);
  }

  /**
   * Discover debt tokens from the Spoke contract's borrowable reserves.
   * Reads Spoke address from the AaveAdapter, then enumerates reserves.
   */
  async discoverDebtTokens(): Promise<void> {
    this.logger.info("Discovering debt tokens from Spoke...");

    const spokeAddress = await this.publicClient.readContract({
      address: this.adapterAddress,
      abi: adapterAbi,
      functionName: "BTC_VAULT_CORE_SPOKE",
    });

    this.logger.info(`Spoke address: ${spokeAddress}`);

    const reserveCount = await this.publicClient.readContract({
      address: spokeAddress,
      abi: spokeAbi,
      functionName: "getReserveCount",
    });

    this.logger.info(`Found ${reserveCount} reserve(s)`);

    const discovered: Address[] = [];

    for (let i = 0n; i < reserveCount; i++) {
      const reserve = await this.publicClient.readContract({
        address: spokeAddress,
        abi: spokeAbi,
        functionName: "getReserve",
        args: [i],
      });

      if (isBorrowableReserve(reserve.flags)) {
        discovered.push(reserve.underlying);

        const { symbol } = await this.getTokenMeta(reserve.underlying);

        this.logger.info(`  Reserve ${i}: ${symbol} (${reserve.underlying}) - borrowable`);
      }
    }

    if (discovered.length === 0) {
      this.logger.warn("No borrowable reserves found on Spoke");
    }

    this.debtTokenAddresses = discovered;
  }

  /**
   * Resolve this engine's in-flight `liquidation` intents against the chain — the crash- and
   * ambiguous-send-safety step. Run **every cycle** (start of `run()`) so an intent left live
   * by a send error is resolved by its reserved nonce vs. the chain (mempool ⇒ hold; mined ⇒
   * re-drive on settled state; not-broadcast ⇒ re-drive). No-op without a store.
   */
  async reconcile(): Promise<void> {
    await reconcileIntents(
      this.store,
      this.publicClient,
      this.walletClient.account.address,
      "liquidation",
      this.logger
    );
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
      // 0. Risk gate — a HALTED gate (kill-switch or tripped breaker) skips the cycle.
      if (this.risk.state() === "HALTED") {
        this.logger.warn("Risk gate is HALTED — skipping liquidation run");
        return;
      }

      // 0.5. Crash-/ambiguous-send-safety: resolve in-flight intents against the chain, then
      // re-seed the shared nonce lease from the chain (reclaiming any not-broadcast nonce).
      // Both no-op without a store / allocator. Done before fetching so a position stuck as a
      // live intent is resolved even in a cycle that would otherwise skip it.
      await this.reconcile();
      await resyncNonces(this.nonces, this.publicClient, this.walletClient.account.address);

      // 1. Fetch liquidatable positions from Ponder (with the freshness stamp of its reads)
      const { positions, dataTimestampMs } = await this.fetchLiquidatablePositions();

      this.metrics.recordPositionsLiquidatable(positions.length);

      if (positions.length === 0) {
        this.logger.info("No liquidatable positions found");
        return;
      }

      this.logger.info(`Found ${positions.length} liquidatable position(s)`);

      // 2. Estimate liquidation inputs via Lens for each position
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

      // 3. Build position + amounts pairs, filter failed estimates
      const candidates: Array<{
        position: LiquidatablePosition;
        amounts: readonly bigint[];
      }> = [];

      for (let i = 0; i < estimateResults.length; i++) {
        const result = estimateResults[i];
        const pos = positions[i];

        if (result.status === "fulfilled") {
          const [amounts] = result.value;
          // Buffer each amount (default 1%) to cover interest accrual between the Lens
          // read and execution. The Lens also returns a separate `wbtcPayment` (fairness
          // + redemption fee) the adapter pulls from msg.sender, so the bot only needs
          // WBTC approved + balance — no need to thread the amount through.
          candidates.push({ position: pos, amounts: bufferAmounts(amounts) });
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

      // 4. Simulate all liquidations in parallel
      const simulationResults = await Promise.allSettled(
        candidates.map(({ position, amounts }) => {
          // Default sequential priority order per candidate (each may have different reserve count)
          const priorityOrder = sequentialPriorityOrder(amounts.length);
          return this.isDirectRedemption
            ? this.publicClient.simulateContract({
                address: this.adapterAddress,
                abi: adapterAbi,
                functionName: "liquidate",
                args: [
                  position.borrower,
                  this.btcRedeemKey,
                  [...amounts],
                  [...priorityOrder],
                  0n,
                  maxUint256,
                ],
                account: this.walletClient.account,
              })
            : this.publicClient.simulateContract({
                address: this.adapterAddress,
                abi: adapterAbi,
                functionName: "liquidateWithLLP",
                args: [position.borrower, this.llpAddress, [...amounts], [...priorityOrder], []],
                account: this.walletClient.account,
              });
        })
      );

      const validCandidates: typeof candidates = [];
      for (let i = 0; i < simulationResults.length; i++) {
        const result = simulationResults[i];
        const candidate = candidates[i];
        if (result.status === "fulfilled") {
          validCandidates.push(candidate);
        } else {
          this.metrics.recordSimulationFailed();
          const reason = result.reason;
          let errorMsg = "Unknown error";
          if (reason instanceof ContractFunctionRevertedError) {
            errorMsg = reason.data?.errorName || reason.message;
          } else if (reason instanceof Error) {
            errorMsg = reason.message;
          }
          this.logger.warn(`Simulation failed for ${candidate.position.proxyAddress}: ${errorMsg}`);
        }
      }

      if (validCandidates.length === 0) {
        this.logger.info("No positions passed simulation");
        return;
      }

      this.logger.info(`${validCandidates.length}/${positions.length} positions passed simulation`);

      // 5. Send. Every tx routes through the shared nonce allocator (`withNonce`) when one is
      // injected — the single nonce owner across both engines; otherwise nonces stay in-memory
      // (behavior-preserving). A send error is treated as AMBIGUOUS (the tx may have
      // propagated): the intent is kept LIVE (never terminal) and the cycle stops — the next
      // cycle's reconcile resolves it by nonce vs. chain.
      const signer = this.walletClient.account.address;
      let localNonce = this.nonces ? 0 : await nextNonce(this.publicClient, signer);

      // Each sent tx is paired with its intent id (so the receipt phase can transition it) and
      // its risk slot (so the receipt phase settles the exposure it reserved).
      const sent: Array<{ hash: Hex; intentId?: string; slot: RiskSlot }> = [];
      for (let i = 0; i < validCandidates.length; i++) {
        const { position, amounts } = validCandidates[i];

        // Risk gate — per-candidate check just before submit. An allowed check reserves an
        // exposure slot that MUST be settled on every path below (see `RiskSlot`).
        //
        // `expectedProfit` is intentionally **not** passed: liquidation profit is not derivable
        // off-chain today. The Lens `estimateLiquidation` returns debt amounts (in debt-token
        // units) + `wbtcPayment` + vault *ids*, and `liquidate`/`liquidateWithLLP` return only
        // `vaultIds` — so neither the estimate nor a simulation yields a WBTC-denominated
        // profit. Pricing it needs an oracle, a new Lens view, or the on-chain WBTC-delta
        // ProfitGuard (RFC-001). The gate skips the profit floor when this is undefined.
        const slot = this.risk.openSlot({
          kind: "liquidation",
          subject: position.proxyAddress,
          dataTimestampMs,
        });
        if (!slot.allowed) {
          this.metrics.recordError("risk_blocked");
          this.logger.warn(`Risk gate blocked ${position.proxyAddress}: ${slot.reason}`);
          continue;
        }
        slots.push(slot);

        // Crash-safety: refuse a duplicate live intent (already pending/submitted on chain).
        const { claimed, intentId } = await claimIntent(this.store, this.logger, slot, {
          chainId: this.walletClient.chain.id,
          target: this.adapterAddress,
          action: "liquidation",
          subject: position.proxyAddress,
        });
        if (!claimed) {
          this.metrics.recordError("intent_in_flight");
          continue;
        }

        const priorityOrder = sequentialPriorityOrder(amounts.length);
        // Runs under the nonce lock (when allocated): persist the reserved nonce to the intent
        // BEFORE broadcast (so a crash/ambiguous send leaves a resolvable intent), then send.
        const broadcast = async (nonce: number): Promise<Hex> => {
          if (this.store && intentId) await this.store.transition(intentId, "pending", { nonce });
          return this.isDirectRedemption
            ? this.walletClient.writeContract({
                address: this.adapterAddress,
                abi: adapterAbi,
                functionName: "liquidate",
                args: [
                  position.borrower,
                  this.btcRedeemKey,
                  [...amounts],
                  [...priorityOrder],
                  0n,
                  maxUint256,
                ],
                nonce,
              })
            : this.walletClient.writeContract({
                address: this.adapterAddress,
                abi: adapterAbi,
                functionName: "liquidateWithLLP",
                args: [position.borrower, this.llpAddress, [...amounts], [...priorityOrder], []],
                nonce,
              });
        };

        let hash: Hex;
        try {
          hash = this.nonces ? await this.nonces.withNonce(broadcast) : await broadcast(localNonce);
        } catch (error) {
          this.metrics.recordError("tx_send_error");
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          this.logger.error(`Failed to send liquidation for ${position.borrower}: ${errorMsg}`);
          // A broadcast was attempted and failed — real failure signal for the breaker.
          slot.settle({ ok: false });
          // Ambiguous — keep the intent LIVE (not terminal); next-cycle reconcile decides.
          if (intentId) {
            await bestEffortTransition(this.store, this.logger, intentId, "submitted", {
              error: errorMsg,
            });
          }
          if (this.nonces) break; // allocator: stop the cycle; resync reclaims the nonce
          // Legacy (no allocator): re-sync the local nonce from the chain and continue.
          try {
            localNonce = await nextNonce(this.publicClient, signer);
          } catch (nonceError) {
            this.logger.error(
              "Failed to re-sync nonce, skipping remaining candidates:",
              nonceError
            );
            break;
          }
          continue;
        }

        // Broadcast succeeded — record it best-effort; a bookkeeping failure here is logged,
        // not fatal, and never marks the intent failed (the tx is on chain).
        this.logger.info(`Sent liquidation for ${position.borrower}: ${hash}`);
        if (intentId) {
          await bestEffortTransition(this.store, this.logger, intentId, "submitted", {
            txHash: hash,
          });
        }
        sent.push({ hash, intentId, slot });
        if (!this.nonces) localNonce += 1;
      }

      if (sent.length === 0) {
        this.logger.info("No liquidation txs were sent");
        return;
      }

      // 6. Batch-wait for all receipts
      this.logger.info(`Waiting for ${sent.length} liquidation receipt(s)...`);
      const receipts = await Promise.allSettled(
        sent.map(({ hash }) =>
          this.publicClient.waitForTransactionReceipt({ hash, timeout: this.txReceiptTimeoutMs })
        )
      );

      for (let i = 0; i < receipts.length; i++) {
        const result = receipts[i];
        const { hash, intentId, slot } = sent[i];
        if (result.status === "fulfilled") {
          const receipt = result.value;
          if (receipt.status === "success") {
            slot.settle({ ok: true });
            this.metrics.recordLiquidationSuccess();
            this.logger.info(`Liquidation confirmed in block ${receipt.blockNumber}: ${hash}`);
            if (intentId)
              await bestEffortTransition(this.store, this.logger, intentId, "confirmed", {
                txHash: hash,
              });
          } else {
            slot.settle({ ok: false });
            this.metrics.recordLiquidationFailed();
            this.metrics.recordError("tx_reverted");
            this.logger.error(`Liquidation reverted: ${hash}`);
            if (intentId)
              await bestEffortTransition(this.store, this.logger, intentId, "failed", {
                txHash: hash,
                error: "reverted",
              });
          }
        } else {
          slot.settle({ ok: false });
          this.metrics.recordLiquidationFailed();
          this.metrics.recordError("receipt_fetch_error");
          this.logger.error(`Failed to get receipt for ${hash}: ${result.reason}`);
          // Leave the intent 'submitted' — boot reconcile resolves it against the chain.
        }
      }
    } catch (error) {
      this.metrics.recordError("poll_error");
      this.logger.error("Error in bot run:", error);
    } finally {
      settleUnfinished(slots);
      this.metrics.recordPollDuration(Date.now() - startTime);
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
      const response = await fetchWithRetry(
        `${this.ponderUrl}/liquidatable-positions`,
        undefined,
        DEFAULT_FETCH_RETRY
      );

      if (!response.ok) {
        throw new Error(`Ponder API error: ${response.status}`);
      }

      const data: PonderResponse = await response.json();
      this.metrics.recordPositionsChecked(data.checked);
      return { positions: data.liquidatable, dataTimestampMs: data.dataTimestampMs };
    } catch (error) {
      this.metrics.recordError("ponder_fetch_error");
      this.logger.error("Failed to fetch liquidatable positions:", error);
      return { positions: [] };
    }
  }

  /**
   * Ensure liquidator has approved AaveAdapter to spend all debt tokens and WBTC.
   * WBTC is approved unconditionally so the adapter can pull the fairness payment
   * and direct-redemption fee (`wbtcPayment` from the Lens) during liquidation.
   */
  async ensureApproval(): Promise<void> {
    const liquidator = this.walletClient.account.address;

    const tokensToApprove = Array.from(
      new Set<Address>([...this.debtTokenAddresses, this.wbtcAddress])
    );

    for (const tokenAddress of tokensToApprove) {
      const allowance = await readAllowance(
        this.publicClient,
        tokenAddress,
        liquidator,
        this.adapterAddress
      );

      if (allowance < maxUint256 / 2n) {
        const { symbol } = await this.getTokenMeta(tokenAddress);

        this.logger.info(`Approving ${symbol} for AaveAdapter...`);

        // Approvals are signer txs too — route through the allocator so they don't collide
        // with the other engine's nonces (only the broadcast is under the lock; the receipt
        // wait is outside). An ambiguous approval is idempotent — re-checked here next boot.
        const hash = await sendMaybeAllocated(this.nonces, (nonce) =>
          approveMax(this.walletClient, tokenAddress, this.adapterAddress, nonce)
        );

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          timeout: this.txReceiptTimeoutMs,
        });
        if (receipt.status !== "success") {
          throw new Error(`Approval transaction reverted for ${symbol}`);
        }
        this.logger.info(`Approved ${symbol}`);
      }
    }
  }

  /**
   * Log and record liquidator's token balances (debt tokens + WBTC)
   */
  async logBalances(): Promise<void> {
    const liquidator = this.walletClient.account.address;

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
