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
} from "viem";

import { vaultSwapAbi } from "@repo/abis";
import {
  type TokenMeta,
  approveMax,
  readAllowance,
  readBalance,
  readTokenMeta,
} from "@repo/capital";
import { type RetryConfig, fetchWithRetry, withRetry } from "@repo/chain";
import { maxWbtcInWithSlippage } from "@repo/domain";
import {
  type NonceAllocator,
  type TxSender,
  createTxSender,
  waitForReceiptWithTimeout,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { StateStore } from "@repo/persistence";
import type { RiskGate } from "@repo/risk";
import {
  bestEffortTransition,
  reconcileIntents,
  resyncNonces,
  sendMaybeAllocated,
} from "../crashSafety";
import type { EscrowedVault, PonderResponse } from "./types";

/**
 * Outcome of one `acquireVault`. `send-error` (the broadcast threw — ambiguous) tells `run()`
 * to stop the cycle, since the failed nonce may leave a gap; `skipped` (not found / unprofitable
 * / risk-blocked / gas-fail / duplicate / revert / timeout) lets the loop continue.
 */
export type AcquireOutcome = "acquired" | "skipped" | "send-error";

/** Observability port — the engine reports through it; the service supplies metrics. */
export interface ArbitrageMetrics {
  recordError(type: string): void;
  recordPollDuration(durationMs: number): void;
  recordVaultAcquired(debt: bigint): void;
  recordWbtcBalance(balance: bigint): void;
}

/**
 * Domain parameters the arbitrage pipeline operates on — the env-derivable
 * subset shared by the engine config and the service's own config (no runtime
 * deps like clients or metrics). Services extend this so the fields are declared
 * once, here, next to the engine that consumes them.
 */
export interface ArbitrageEngineParams {
  vaultSwapAddress: Address;
  wbtcAddress: Address;
  ponderUrl: string;
  maxSlippageBps: number;
  vaultProcessingDelayMs: number;
  txReceiptTimeoutMs: number;
}

export interface ArbitrageEngineConfig extends ArbitrageEngineParams {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  retryConfig: RetryConfig;
  metrics: ArbitrageMetrics;
  logger: Logger;
  risk: RiskGate;
  /** Crash-safety store (intent idempotency); absent ⇒ no intent tracking. */
  store?: StateStore;
  /** Shared nonce authority; absent ⇒ viem auto-nonce (behavior-preserving). */
  nonces?: NonceAllocator;
  /** How txs are signed + broadcast; absent ⇒ local signing to the public mempool. */
  sender?: TxSender;
  /** Called at the end of each `run()` (e.g. to update the health poll timestamp). */
  onPollComplete?: () => void;
}

export class ArbitrageEngine {
  private metrics: ArbitrageMetrics;
  private logger: Logger;
  private risk: RiskGate;
  private store?: StateStore;
  private nonces?: NonceAllocator;
  private sender: TxSender;
  private onPollComplete?: () => void;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private vaultSwapAddress: Address;
  private wbtcAddress: Address;
  private ponderUrl: string;
  private maxSlippageBps: number;
  private vaultProcessingDelayMs: number;
  private retryConfig: RetryConfig;
  private txReceiptTimeoutMs: number;
  private wbtcMeta?: TokenMeta;

  constructor(config: ArbitrageEngineConfig) {
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.risk = config.risk;
    this.store = config.store;
    this.nonces = config.nonces;
    this.sender = config.sender ?? createTxSender(config.publicClient, config.walletClient);
    this.onPollComplete = config.onPollComplete;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.wbtcAddress = config.wbtcAddress;
    this.ponderUrl = config.ponderUrl;
    this.maxSlippageBps = config.maxSlippageBps;
    this.vaultProcessingDelayMs = config.vaultProcessingDelayMs;
    this.retryConfig = config.retryConfig;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs;
  }

  /**
   * Run one iteration of the arbitrageur bot
   */
  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      // 0. Risk gate — a HALTED gate (kill-switch or tripped breaker) skips the cycle.
      if (this.risk.state() === "HALTED") {
        this.logger.warn("Risk gate is HALTED — skipping arbitrage run");
        return;
      }

      // 0.5. Crash-/ambiguous-send-safety: resolve in-flight vault-acquisition intents, then
      // re-seed the shared nonce lease from the chain. Both no-op without a store / allocator.
      await this.reconcile();
      await resyncNonces(this.nonces, this.publicClient, this.walletClient.account.address);

      // 1. Fetch escrowed vaults from Ponder
      const vaults = await this.fetchEscrowedVaults();

      if (vaults.length === 0) {
        this.logger.info("No escrowed vaults available");
        return;
      }

      this.logger.info(`Found ${vaults.length} escrowed vault(s)`);

      // 2. Process each vault one by one
      for (const vault of vaults) {
        const outcome = await this.acquireVault(vault);

        // A send error is ambiguous and leaves a possible nonce gap — stop the cycle (like
        // the liquidation engine). The next cycle's reconcile + resync resolve it and re-drive.
        if (outcome === "send-error") {
          this.logger.warn("Stopping this cycle after a send error; will re-drive next cycle");
          break;
        }

        // Delay between processing vaults
        if (this.vaultProcessingDelayMs > 0) {
          await this.sleep(this.vaultProcessingDelayMs);
        }
      }
    } catch (error) {
      this.logger.error("Error in bot run:", error);
      this.metrics.recordError("poll_error");
    } finally {
      // Record poll duration and update last poll time
      const duration = Date.now() - startTime;
      this.metrics.recordPollDuration(duration);
      this.onPollComplete?.();
    }
  }

  /**
   * Resolve this engine's in-flight `vault-acquisition` intents against the chain — the crash-
   * and ambiguous-send-safety step, run every cycle (start of `run()`). No-op without a store.
   */
  async reconcile(): Promise<void> {
    await reconcileIntents(
      this.store,
      this.publicClient,
      this.walletClient.account.address,
      "vault-acquisition",
      this.logger
    );
  }

  /**
   * Fetch escrowed vaults from Ponder indexer with retry
   */
  private async fetchEscrowedVaults(): Promise<EscrowedVault[]> {
    try {
      const response = await fetchWithRetry(
        `${this.ponderUrl}/escrowed-vaults`,
        undefined,
        this.retryConfig
      );

      if (!response.ok) {
        throw new Error(`Ponder API error: ${response.status}`);
      }

      const data: PonderResponse = await response.json();
      if (!Array.isArray(data.vaults)) {
        throw new Error("Invalid Ponder response: vaults must be an array");
      }
      return data.vaults;
    } catch (error) {
      this.logger.error("Failed to fetch escrowed vaults:", error);
      this.metrics.recordError("ponder_fetch_error");
      return [];
    }
  }

  /**
   * Acquire a vault by swapping WBTC for it (redemption is atomic). Returns an outcome so the
   * poll loop knows whether to continue (`skipped`/`acquired`) or stop the cycle (`send-error`).
   */
  async acquireVault(vault: EscrowedVault): Promise<AcquireOutcome> {
    const { vaultId, btcAmount, currentDebt } = vault;
    const currentDebtBigInt = BigInt(currentDebt);
    const btcAmountBigInt = BigInt(btcAmount);

    this.logger.info("Attempting to acquire vault:");
    this.logger.info(`   Vault ID: ${vaultId}`);
    this.logger.info(`   BTC Amount: ${formatUnits(btcAmountBigInt, 8)} WBTC`);
    this.logger.info(`   Current Debt: ${formatUnits(currentDebtBigInt, 8)} WBTC`);

    try {
      const previewResults = await this.publicClient.readContract({
        address: this.vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "previewEscrowedVaults",
        args: [[vaultId as Hex]],
      });

      if (previewResults.length === 0) {
        this.logger.warn(`Vault ${vaultId} not found in escrow, skipping`);
        this.metrics.recordError("vault_skipped");
        return "skipped";
      }

      const preview = previewResults[0];
      if (preview.amountProfitEst === 0n) {
        this.logger.warn(`Vault ${vaultId} is currently unprofitable, skipping`);
        this.logger.warn(
          `   Debt: ${formatUnits(preview.amountDebt, 8)} WBTC | Interest: ${formatUnits(preview.amountInterest, 8)} WBTC | Fee: ${formatUnits(preview.amountFee, 8)} WBTC`
        );
        this.metrics.recordError("vault_skipped");
        return "skipped";
      }

      // Risk gate — check just before committing to the acquisition.
      const decision = this.risk.check({ kind: "vault-acquisition", subject: vaultId });
      if (!decision.allow) {
        this.logger.warn(`Risk gate blocked vault ${vaultId}: ${decision.reason}`);
        this.metrics.recordError("risk_blocked");
        return "skipped";
      }

      // Calculate maxWbtcIn with slippage buffer
      const maxWbtcIn = maxWbtcInWithSlippage(currentDebtBigInt, this.maxSlippageBps);

      // Ensure WBTC approval covers the slippage-adjusted max spend amount
      await this.ensureApproval(maxWbtcIn);

      this.logger.info(
        `Max WBTC willing to pay: ${formatUnits(maxWbtcIn, 8)} (${this.maxSlippageBps / 100}% slippage)`
      );

      // Estimate gas first to catch potential failures early
      try {
        await this.publicClient.estimateContractGas({
          address: this.vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "swapWbtcForVault",
          args: [vaultId as Hex, maxWbtcIn],
          account: this.walletClient.account,
        });
      } catch (gasError) {
        const errorMsg = gasError instanceof Error ? gasError.message : String(gasError);
        this.logger.error(`Gas estimation failed for vault ${vaultId}, skipping`);
        this.logger.error(`   Error: ${errorMsg}`);
        this.metrics.recordError("gas_estimation_failed");
        return "skipped";
      }

      // Crash-safety: refuse a duplicate live acquisition intent (already in flight on chain).
      let intentId: string | undefined;
      if (this.store) {
        const record = await this.store.recordIntent({
          chainId: this.walletClient.chain.id,
          target: this.vaultSwapAddress,
          action: "vault-acquisition",
          subject: vaultId,
        });
        if (!record.recorded) {
          this.logger.warn(`Skipping vault ${vaultId}: intent already ${record.existing.status}`);
          this.metrics.recordError("intent_in_flight");
          return "skipped";
        }
        intentId = record.id;
      }

      // Execute swap via VaultSwap (redemption is atomic). Route through the shared nonce
      // allocator when present; otherwise viem fills the nonce from the chain. The sender signs
      // locally first, so `onSigned` durably records nonce + hash while the tx is still local —
      // an ambiguous broadcast then leaves an intent reconcile can resolve by receipt lookup.
      const broadcast = (nonce?: number): Promise<Hex> =>
        this.sender.send(
          {
            address: this.vaultSwapAddress,
            abi: vaultSwapAbi,
            functionName: "swapWbtcForVault",
            args: [vaultId as Hex, maxWbtcIn],
            ...(nonce !== undefined ? { nonce } : {}),
          },
          async (signed) => {
            if (this.store && intentId) {
              await this.store.transition(intentId, "pending", {
                nonce: signed.nonce,
                txHash: signed.hash,
              });
            }
          }
        );

      let hash: Hex;
      try {
        hash = await sendMaybeAllocated(this.nonces, (nonce) => broadcast(nonce));
      } catch (sendError) {
        const errorMsg = sendError instanceof Error ? sendError.message : String(sendError);
        this.logger.error(`Failed to send swap for vault ${vaultId}: ${errorMsg}`);
        this.metrics.recordError("swap_send_error");
        this.risk.recordOutcome({ ok: false });
        // Ambiguous — keep the intent live. The signed hash is already durable (unless the
        // failure *was* that record, in which case nothing was broadcast), so next-cycle
        // reconcile resolves it by receipt lookup rather than inferring from the nonce.
        if (intentId) {
          await bestEffortTransition(this.store, this.logger, intentId, "submitted", {
            error: errorMsg,
          });
        }
        return "send-error"; // stop the cycle — possible nonce gap
      }

      this.logger.info(`Swap transaction sent: ${hash}`);
      // Status bump only — the hash was persisted pre-broadcast, so losing this write is safe.
      if (intentId) {
        await bestEffortTransition(this.store, this.logger, intentId, "submitted", {
          txHash: hash,
        });
      }

      // Wait for confirmation with timeout
      const receipt = await waitForReceiptWithTimeout(
        this.publicClient,
        hash,
        this.txReceiptTimeoutMs,
        "swap"
      );

      if (!receipt) {
        this.risk.recordOutcome({ ok: false });
        this.logger.warn(`Transaction receipt timeout for vault ${vaultId}`);
        this.metrics.recordError("tx_timeout");
        // Leave the intent live (submitted) — reconcile resolves it against the chain.
        return "skipped";
      }

      if (receipt.status === "success") {
        this.risk.recordOutcome({ ok: true });
        this.logger.info(`Vault acquired and redeemed in block ${receipt.blockNumber}`);
        this.metrics.recordVaultAcquired(currentDebtBigInt);
        if (intentId)
          await bestEffortTransition(this.store, this.logger, intentId, "confirmed", {
            txHash: hash,
          });
        return "acquired";
      }
      this.risk.recordOutcome({ ok: false });
      this.logger.error("Swap transaction reverted");
      this.metrics.recordError("swap_reverted");
      if (intentId)
        await bestEffortTransition(this.store, this.logger, intentId, "failed", {
          txHash: hash,
          error: "reverted",
        });
      return "skipped";
    } catch (error) {
      this.risk.recordOutcome({ ok: false });
      let errorMsg = "Unknown error";
      if (error instanceof ContractFunctionRevertedError) {
        errorMsg = `${error.data?.errorName || "Contract reverted"}`;
        this.metrics.recordError("contract_revert");
      } else if (error instanceof Error) {
        errorMsg = error.message;
        this.metrics.recordError("acquire_error");
      }

      this.logger.error(`Failed to acquire vault ${vaultId}`);
      this.logger.error(`   Error: ${errorMsg}`);
      return "skipped";
    }
  }

  /**
   * Ensure arbitrageur has approved VaultSwap to spend WBTC
   */
  private async ensureApproval(requiredAmount: bigint): Promise<void> {
    const arbitrageur = this.walletClient.account.address;

    // Check current allowance for VaultSwap contract with retry
    const allowance = await withRetry(
      () => readAllowance(this.publicClient, this.wbtcAddress, arbitrageur, this.vaultSwapAddress),
      this.retryConfig,
      "allowance check"
    );

    // If allowance is insufficient, approve max
    if (allowance < requiredAmount) {
      this.logger.info("Approving WBTC for VaultSwap...");

      // Route through the allocator (this approval runs mid-poll and would otherwise collide
      // with the liquidation engine's nonces). Only the broadcast is under the lock.
      const hash = await sendMaybeAllocated(this.nonces, (nonce) =>
        approveMax(this.walletClient, this.wbtcAddress, this.vaultSwapAddress, nonce)
      );

      const receipt = await waitForReceiptWithTimeout(
        this.publicClient,
        hash,
        this.txReceiptTimeoutMs,
        "approval"
      );
      if (!receipt) {
        throw new Error("Approval transaction timed out");
      }
      if (receipt.status !== "success") {
        throw new Error("Approval transaction reverted");
      }
      this.logger.info("Approval confirmed");
    }
  }

  /**
   * Resolve and cache WBTC symbol + decimals.
   * ERC-20 metadata is immutable per address — fetched once, reused forever.
   */
  private async getWbtcMeta(): Promise<TokenMeta> {
    if (this.wbtcMeta) return this.wbtcMeta;

    this.wbtcMeta = await withRetry(
      () => readTokenMeta(this.publicClient, this.wbtcAddress),
      this.retryConfig,
      "wbtc metadata"
    );
    return this.wbtcMeta;
  }

  /**
   * Log arbitrageur's WBTC balance
   */
  async logBalance(): Promise<void> {
    const arbitrageur = this.walletClient.account.address;

    try {
      // Run metadata + balanceOf in parallel: cold-start is no slower than
      // before (still 3 concurrent reads); steady-state is just balanceOf.
      const [{ symbol, decimals }, balance] = await Promise.all([
        this.getWbtcMeta(),
        withRetry(
          () => readBalance(this.publicClient, this.wbtcAddress, arbitrageur),
          this.retryConfig,
          "balance check"
        ),
      ]);

      const formattedBalance = formatUnits(balance, decimals);
      this.logger.info(`Arbitrageur balance: ${formattedBalance} ${symbol}`);
      this.metrics.recordWbtcBalance(balance);
    } catch (error) {
      this.logger.error("Failed to fetch balance:", error);
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
