import {
  type Address,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  formatUnits,
} from "viem";

import { vaultSwapAbi } from "@repo/abis";
import { type TokenMeta, readBalance, readTokenMeta } from "@repo/capital";
import { type RetryConfig, fetchWithRetry, withRetry } from "@repo/chain";
import { maxWbtcInWithSlippage } from "@repo/domain";
import { type ExecutionIdentity, waitForReceiptWithTimeout } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type RiskGate, type RiskSlot, settleUnfinished } from "@repo/risk";
import type { AllowanceResult, Executor } from "../executor";
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
  publicClient: PublicClient;
  retryConfig: RetryConfig;
  metrics: ArbitrageMetrics;
  logger: Logger;
  risk: RiskGate;
  /**
   * The execution-mode seam and the engine's sole execution collaborator: how each acquisition is
   * committed (AUTO sign+broadcast vs keyless MANUAL propose+notify), plus who the txs come from
   * (`executor.identity`). The composition root (`@repo/runtime`) builds it — an `AutoExecutor`
   * wrapping the wallet + shared nonce authority, or a keyless `ManualExecutor` — and injects it, so
   * the engine holds no `WalletClient`, `TxSender`, or nonce state of its own. Both engines the
   * arbitrageur runs share one instance, so they never collide on a nonce.
   */
  executor: Executor;
  /** Called at the end of each `run()` (e.g. to update the health poll timestamp). */
  onPollComplete?: () => void;
}

export class ArbitrageEngine {
  private metrics: ArbitrageMetrics;
  private logger: Logger;
  private risk: RiskGate;
  /** The engine's one execution collaborator (see `executor.ts`). The engine reaches nothing lower. */
  private executor: Executor;
  private onPollComplete?: () => void;
  private publicClient: PublicClient;
  private vaultSwapAddress: Address;
  private wbtcAddress: Address;
  private ponderUrl: string;
  private maxSlippageBps: number;
  private vaultProcessingDelayMs: number;
  private retryConfig: RetryConfig;
  private txReceiptTimeoutMs: number;
  private wbtcMeta?: TokenMeta;

  /** Who these txs come from — the executor's identity (the signer in AUTO, the operator in MANUAL). */
  private get identity(): ExecutionIdentity {
    return this.executor.identity;
  }

  constructor(config: ArbitrageEngineConfig) {
    this.metrics = config.metrics;
    this.logger = config.logger;
    this.risk = config.risk;
    this.onPollComplete = config.onPollComplete;
    this.publicClient = config.publicClient;
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.wbtcAddress = config.wbtcAddress;
    this.ponderUrl = config.ponderUrl;
    this.maxSlippageBps = config.maxSlippageBps;
    this.vaultProcessingDelayMs = config.vaultProcessingDelayMs;
    this.retryConfig = config.retryConfig;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs;
    this.executor = config.executor;
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

      // 0.5. Crash-/ambiguous-send-safety: resolve in-flight vault-acquisition intents (no-op
      // without a store), then re-seed the shared nonce lease from the chain (reclaiming any
      // reserved-but-not-broadcast nonce).
      await this.reconcile();
      await this.executor.resyncNonces();

      // 1. Fetch escrowed vaults from Ponder (with the freshness stamp of its reads)
      const { vaults, dataTimestampMs } = await this.fetchEscrowedVaults();

      if (vaults.length === 0) {
        this.logger.info("No escrowed vaults available");
        return;
      }

      this.logger.info(`Found ${vaults.length} escrowed vault(s)`);

      // 2. Process each vault one by one
      for (const vault of vaults) {
        const outcome = await this.acquireVault(vault, dataTimestampMs);

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
    await this.executor.reconcile("vault-acquisition");
  }

  /**
   * Fetch escrowed vaults from Ponder indexer with retry
   */
  private async fetchEscrowedVaults(): Promise<{
    vaults: EscrowedVault[];
    dataTimestampMs?: number;
  }> {
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
      return { vaults: data.vaults, dataTimestampMs: data.dataTimestampMs };
    } catch (error) {
      this.logger.error("Failed to fetch escrowed vaults:", error);
      this.metrics.recordError("ponder_fetch_error");
      return { vaults: [] };
    }
  }

  /**
   * Acquire a vault by swapping WBTC for it (redemption is atomic). Returns an outcome so the
   * poll loop knows whether to continue (`skipped`/`acquired`) or stop the cycle (`send-error`).
   */
  async acquireVault(vault: EscrowedVault, dataTimestampMs?: number): Promise<AcquireOutcome> {
    const { vaultId, btcAmount, currentDebt } = vault;
    const currentDebtBigInt = BigInt(currentDebt);
    const btcAmountBigInt = BigInt(btcAmount);
    // Assigned once the risk gate allows this acquisition; from then on every exit must settle it
    // (the `finally` is the backstop). Stays undefined if we bail before ever asking the gate —
    // in which case there is no exposure slot, and nothing to record.
    let slot: RiskSlot | undefined;

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

      // Slippage-adjusted ceiling on what we will pay. `swapWbtcForVault` charges the debt+fee
      // prevailing at execution and only reverts *above* this ceiling, so `maxWbtcIn` — not the
      // preview cost — is the amount the tx actually authorizes.
      const maxWbtcIn = maxWbtcInWithSlippage(currentDebtBigInt, this.maxSlippageBps);

      // Risk gate — check just before committing to the acquisition. The profit floor must bound
      // the WORST case the tx permits, not the optimistic preview: interest can accrue between
      // preview and execution and the swap still succeeds anywhere up to `maxWbtcIn`. Both legs
      // are 8-dec sats (we receive the vault's BTC, we pay WBTC), so this is already the unit
      // `minProfit` expects. May be negative — bigint comparison handles that.
      const expectedProfit = preview.amountVault - maxWbtcIn;
      slot = this.risk.openSlot({
        kind: "vault-acquisition",
        subject: vaultId,
        expectedProfit,
        dataTimestampMs,
      });
      if (!slot.allowed) {
        this.logger.warn(`Risk gate blocked vault ${vaultId}: ${slot.reason}`);
        this.metrics.recordError("risk_blocked");
        return "skipped";
      }

      // Ensure WBTC approval covers the slippage-adjusted max spend amount. AUTO broadcasts +
      // waits (only ever returns `satisfied`); MANUAL proposes the approval for the operator to
      // sign and returns `proposed`/`duplicate` — the swap cannot go out until they do, so free
      // the slot and skip this vault (the approval intent stands; a later cycle retries the swap).
      const approval = await this.ensureApproval(maxWbtcIn);
      if (approval.kind !== "satisfied") {
        this.logger.info(`WBTC approval ${approval.kind} — awaiting operator signature`);
        slot.settle({ ok: false, abandoned: true });
        return "skipped";
      }

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
          account: this.identity.from,
        });
      } catch (gasError) {
        const errorMsg = gasError instanceof Error ? gasError.message : String(gasError);
        this.logger.error(`Gas estimation failed for vault ${vaultId}, skipping`);
        this.logger.error(`   Error: ${errorMsg}`);
        this.metrics.recordError("gas_estimation_failed");
        // Nothing broadcast — free the exposure slot without blaming the chain.
        slot.settle({ ok: false, abandoned: true });
        return "skipped";
      }

      // Commit the swap through the mode seam. AUTO signs + broadcasts under the shared nonce lock
      // (claim → send → markPending → submitted, all inside `commit`); MANUAL proposes + notifies.
      const out = await this.executor.commit(
        {
          address: this.vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "swapWbtcForVault",
          args: [vaultId as Hex, maxWbtcIn],
        },
        { target: this.vaultSwapAddress, action: "vault-acquisition", subject: vaultId }
      );

      if (out.kind !== "broadcast") {
        switch (out.kind) {
          case "duplicate":
            // A live intent for this subject already exists — nothing broadcast; free the slot.
            slot.settle({ ok: false, abandoned: true });
            this.metrics.recordError("intent_in_flight");
            return "skipped";
          case "proposed":
            // MANUAL — written down for an operator; nothing on chain, no receipt to await.
            slot.settle({ ok: false, abandoned: true });
            return "skipped";
          case "aborted":
            this.logger.error(`Failed to send swap for vault ${vaultId}: ${out.error}`);
            this.metrics.recordError("swap_send_error");
            // Only a failed *broadcast* is a real failure signal for the breaker; a pre-broadcast
            // failure reached no chain, so an RPC/database blip cannot trip it.
            slot.settle({ ok: false, abandoned: !out.broadcastAttempted });
            // The send left a possible nonce gap — stop the cycle; the next resync reclaims it.
            return "send-error";
          default:
            return out satisfies never; // exhaustiveness — a new `CommitResult` kind must be handled
        }
      }

      // Broadcast (or ambiguously so). The intent is already `submitted` (recorded inside `commit`).
      const { hash, intentId } = out;
      this.logger.info(`Swap transaction sent: ${hash}`);

      // Wait for confirmation with timeout
      const receipt = await waitForReceiptWithTimeout(
        this.publicClient,
        hash,
        this.txReceiptTimeoutMs,
        "swap"
      );

      if (!receipt) {
        slot.settle({ ok: false });
        this.logger.warn(`Transaction receipt timeout for vault ${vaultId}`);
        this.metrics.recordError("tx_timeout");
        // Leave the intent live (submitted) — reconcile resolves it against the chain.
        return "skipped";
      }

      if (receipt.status === "success") {
        slot.settle({ ok: true });
        this.logger.info(`Vault acquired and redeemed in block ${receipt.blockNumber}`);
        this.metrics.recordVaultAcquired(currentDebtBigInt);
        if (intentId)
          await this.executor.recordOutcome(intentId, { kind: "confirmed", txHash: hash });
        return "acquired";
      }
      slot.settle({ ok: false });
      this.logger.error("Swap transaction reverted");
      this.metrics.recordError("swap_reverted");
      if (intentId)
        await this.executor.recordOutcome(intentId, {
          kind: "failed",
          txHash: hash,
          error: "reverted",
        });
      return "skipped";
    } catch (error) {
      // Only counts against the breaker if the gate had already allowed this acquisition. A
      // throw from the preview read or the Ponder fetch is an infrastructure error, not a failed
      // action — and it holds no exposure slot to release. (Those surface via `metrics`.)
      slot?.settle({ ok: false });
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
    } finally {
      // Backstop: no path above may leave the slot reserved. Idempotent, so the real outcomes
      // recorded above win and this only catches the ones nobody settled.
      if (slot) settleUnfinished([slot]);
    }
  }

  /**
   * Ensure the arbitrageur has approved VaultSwap to spend at least `requiredAmount` of WBTC,
   * through the mode seam. AUTO reads the allowance and, if short, broadcasts `approve(max)` + waits
   * (key and all, inside the executor); MANUAL proposes the approval for an operator to sign. The
   * approval runs mid-poll, so the executor routes its broadcast through the shared nonce allocator
   * — otherwise it would collide with the liquidation engine's nonces.
   */
  private ensureApproval(requiredAmount: bigint): Promise<AllowanceResult> {
    return this.executor.ensureAllowance({
      token: this.wbtcAddress,
      spender: this.vaultSwapAddress,
      required: requiredAmount,
      label: "WBTC",
    });
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
    const arbitrageur = this.identity.from;

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
