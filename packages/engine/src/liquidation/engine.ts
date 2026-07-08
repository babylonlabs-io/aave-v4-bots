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
import { nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type ChainReader, type StateStore, reconcilePending } from "@repo/persistence";
import type { RiskGate } from "@repo/risk";
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
   * Crash-safety store. When present, each submit is recorded under an idempotency key and
   * nonces come from a persisted lease, so a restart re-drives without double-sending; when
   * absent, the engine keeps its in-memory chain-nonce sequencing (behavior-preserving).
   */
  store?: StateStore;
}

export class LiquidationEngine {
  private metrics: LiquidationMetrics;
  private logger: Logger;
  private risk: RiskGate;
  private store?: StateStore;
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
   * Boot-time crash-safety: resolve any persisted in-flight intents against the chain
   * **before** the poll loop re-drives, so a crash mid-submit doesn't double-send. No-op
   * without a store. Call once at startup (like `ensureApproval`).
   */
  async reconcile(): Promise<void> {
    if (!this.store) return;
    const reader: ChainReader = {
      getReceiptStatus: async (hash) => {
        try {
          const receipt = await this.publicClient.getTransactionReceipt({ hash });
          return receipt.status === "success" ? "success" : "reverted";
        } catch {
          return null; // receipt not found yet
        }
      },
      getNonce: (address, blockTag) => this.publicClient.getTransactionCount({ address, blockTag }),
    };
    await reconcilePending({
      store: this.store,
      reader,
      signer: this.walletClient.account.address,
      logger: this.logger,
    });
  }

  /**
   * Run one iteration of the liquidation bot.
   * For each position: estimate via Lens, simulate, then execute.
   */
  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      // 0. Risk gate — a HALTED gate (kill-switch or tripped breaker) skips the cycle.
      if (this.risk.state() === "HALTED") {
        this.logger.warn("Risk gate is HALTED — skipping liquidation run");
        return;
      }

      // 1. Fetch liquidatable positions from Ponder
      const positions = await this.fetchLiquidatablePositions();

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

      // 5. Send all liquidation txs with explicit nonces.
      // Re-sync nonce after send failures to avoid gaps/stuck sequence. With a store, the
      // nonce comes from the persisted lease (seeded from the chain here) and each submit is
      // recorded under an idempotency key; without one, nonces stay in-memory (unchanged).
      const signer = this.walletClient.account.address;
      if (this.store) {
        await this.store.syncNonce(signer, await nextNonce(this.publicClient, signer));
      }
      let nonce = this.store ? 0 : await nextNonce(this.publicClient, signer);

      // Each sent tx is paired with its intent id so the receipt phase can transition it.
      const sent: Array<{ hash: Hex; intentId?: string }> = [];
      for (let i = 0; i < validCandidates.length; i++) {
        const { position, amounts } = validCandidates[i];

        // Risk gate — per-candidate check just before submit (profit floor, freshness, …).
        const decision = this.risk.check({ kind: "liquidation", subject: position.proxyAddress });
        if (!decision.allow) {
          this.metrics.recordError("risk_blocked");
          this.logger.warn(`Risk gate blocked ${position.proxyAddress}: ${decision.reason}`);
          continue;
        }

        // Crash-safety: refuse a duplicate live intent, then allocate a persisted nonce.
        let intentId: string | undefined;
        if (this.store) {
          const record = await this.store.recordIntent({
            chainId: this.walletClient.chain.id,
            target: this.adapterAddress,
            action: "liquidation",
            subject: position.proxyAddress,
          });
          if (!record.recorded) {
            this.metrics.recordError("intent_in_flight");
            this.logger.warn(
              `Skipping ${position.proxyAddress}: intent already ${record.existing.status}`
            );
            continue;
          }
          intentId = record.id;
          nonce = await this.store.reserveNonce(signer);
          await this.store.transition(intentId, "pending", { nonce });
        }

        const priorityOrder = sequentialPriorityOrder(amounts.length);
        try {
          const hash = this.isDirectRedemption
            ? await this.walletClient.writeContract({
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
            : await this.walletClient.writeContract({
                address: this.adapterAddress,
                abi: adapterAbi,
                functionName: "liquidateWithLLP",
                args: [position.borrower, this.llpAddress, [...amounts], [...priorityOrder], []],
                nonce,
              });
          this.logger.info(`Sent liquidation for ${position.borrower}: ${hash}`);
          if (intentId) await this.store?.transition(intentId, "submitted", { txHash: hash });
          sent.push({ hash, intentId });
          if (!this.store) nonce += 1;
        } catch (error) {
          this.metrics.recordError("tx_send_error");
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          this.logger.error(`Failed to send liquidation for ${position.borrower}: ${errorMsg}`);
          if (intentId) await this.store?.transition(intentId, "failed", { error: errorMsg });
          try {
            const chainNonce = await nextNonce(this.publicClient, signer);
            if (this.store) await this.store.syncNonce(signer, chainNonce);
            else nonce = chainNonce;
          } catch (nonceError) {
            this.logger.error(
              "Failed to re-sync nonce, skipping remaining candidates:",
              nonceError
            );
            break;
          }
        }
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
        const { hash, intentId } = sent[i];
        if (result.status === "fulfilled") {
          const receipt = result.value;
          if (receipt.status === "success") {
            this.risk.recordOutcome({ ok: true });
            this.metrics.recordLiquidationSuccess();
            this.logger.info(`Liquidation confirmed in block ${receipt.blockNumber}: ${hash}`);
            if (intentId) await this.store?.transition(intentId, "confirmed", { txHash: hash });
          } else {
            this.risk.recordOutcome({ ok: false });
            this.metrics.recordLiquidationFailed();
            this.metrics.recordError("tx_reverted");
            this.logger.error(`Liquidation reverted: ${hash}`);
            if (intentId)
              await this.store?.transition(intentId, "failed", { txHash: hash, error: "reverted" });
          }
        } else {
          this.risk.recordOutcome({ ok: false });
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
      this.metrics.recordPollDuration(Date.now() - startTime);
    }
  }

  /**
   * Fetch liquidatable positions from Ponder indexer
   */
  private async fetchLiquidatablePositions(): Promise<LiquidatablePosition[]> {
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
      return data.liquidatable;
    } catch (error) {
      this.metrics.recordError("ponder_fetch_error");
      this.logger.error("Failed to fetch liquidatable positions:", error);
      return [];
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

        const hash = await approveMax(this.walletClient, tokenAddress, this.adapterAddress);

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
