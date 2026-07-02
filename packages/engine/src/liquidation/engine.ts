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
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  metrics: LiquidationMetrics;
}

export class LiquidationEngine {
  private logTag: string;
  private metrics: LiquidationMetrics;
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
    this.logTag = config.logTag;
    this.metrics = config.metrics;
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
    console.log(`${this.logTag}Discovering debt tokens from Spoke...`);

    const spokeAddress = await this.publicClient.readContract({
      address: this.adapterAddress,
      abi: adapterAbi,
      functionName: "BTC_VAULT_CORE_SPOKE",
    });

    console.log(`${this.logTag}Spoke address: ${spokeAddress}`);

    const reserveCount = await this.publicClient.readContract({
      address: spokeAddress,
      abi: spokeAbi,
      functionName: "getReserveCount",
    });

    console.log(`${this.logTag}Found ${reserveCount} reserve(s)`);

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

        console.log(`${this.logTag}  Reserve ${i}: ${symbol} (${reserve.underlying}) - borrowable`);
      }
    }

    if (discovered.length === 0) {
      console.warn(`${this.logTag}No borrowable reserves found on Spoke`);
    }

    this.debtTokenAddresses = discovered;
  }

  /**
   * Run one iteration of the liquidation bot.
   * For each position: estimate via Lens, simulate, then execute.
   */
  async run(): Promise<void> {
    const startTime = Date.now();

    try {
      // 1. Fetch liquidatable positions from Ponder
      const positions = await this.fetchLiquidatablePositions();

      this.metrics.recordPositionsLiquidatable(positions.length);

      if (positions.length === 0) {
        console.log(`${this.logTag}No liquidatable positions found`);
        return;
      }

      console.log(`${this.logTag}Found ${positions.length} liquidatable position(s)`);

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
          console.warn(`${this.logTag}Lens estimate failed for ${pos.proxyAddress}: ${errorMsg}`);
        }
      }

      if (candidates.length === 0) {
        console.log(`${this.logTag}No positions passed Lens estimation`);
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
          console.warn(
            `${this.logTag}Simulation failed for ${candidate.position.proxyAddress}: ${errorMsg}`
          );
        }
      }

      if (validCandidates.length === 0) {
        console.log(`${this.logTag}No positions passed simulation`);
        return;
      }

      console.log(
        `${this.logTag}${validCandidates.length}/${positions.length} positions passed simulation`
      );

      // 5. Send all liquidation txs with explicit nonces.
      // Re-sync nonce after send failures to avoid gaps/stuck sequence.
      let nonce = await nextNonce(this.publicClient, this.walletClient.account.address);

      const txHashes: Hex[] = [];
      for (let i = 0; i < validCandidates.length; i++) {
        const { position, amounts } = validCandidates[i];
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
          console.log(`${this.logTag}Sent liquidation for ${position.borrower}: ${hash}`);
          txHashes.push(hash);
          nonce += 1;
        } catch (error) {
          this.metrics.recordError("tx_send_error");
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          console.error(
            `${this.logTag}Failed to send liquidation for ${position.borrower}: ${errorMsg}`
          );
          try {
            nonce = await nextNonce(this.publicClient, this.walletClient.account.address);
          } catch (nonceError) {
            console.error(
              `${this.logTag}Failed to re-sync nonce, skipping remaining candidates:`,
              nonceError
            );
            break;
          }
        }
      }

      if (txHashes.length === 0) {
        console.log(`${this.logTag}No liquidation txs were sent`);
        return;
      }

      // 6. Batch-wait for all receipts
      console.log(`${this.logTag}Waiting for ${txHashes.length} liquidation receipt(s)...`);
      const receipts = await Promise.allSettled(
        txHashes.map((hash) =>
          this.publicClient.waitForTransactionReceipt({ hash, timeout: this.txReceiptTimeoutMs })
        )
      );

      for (let i = 0; i < receipts.length; i++) {
        const result = receipts[i];
        if (result.status === "fulfilled") {
          const receipt = result.value;
          if (receipt.status === "success") {
            this.metrics.recordLiquidationSuccess();
            console.log(
              `${this.logTag}Liquidation confirmed in block ${receipt.blockNumber}: ${txHashes[i]}`
            );
          } else {
            this.metrics.recordLiquidationFailed();
            this.metrics.recordError("tx_reverted");
            console.error(`${this.logTag}Liquidation reverted: ${txHashes[i]}`);
          }
        } else {
          this.metrics.recordLiquidationFailed();
          this.metrics.recordError("receipt_fetch_error");
          console.error(`${this.logTag}Failed to get receipt for ${txHashes[i]}: ${result.reason}`);
        }
      }
    } catch (error) {
      this.metrics.recordError("poll_error");
      console.error(`${this.logTag}Error in bot run:`, error);
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
      console.error(`${this.logTag}Failed to fetch liquidatable positions:`, error);
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

        console.log(`${this.logTag}Approving ${symbol} for AaveAdapter...`);

        const hash = await approveMax(this.walletClient, tokenAddress, this.adapterAddress);

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          timeout: this.txReceiptTimeoutMs,
        });
        if (receipt.status !== "success") {
          throw new Error(`Approval transaction reverted for ${symbol}`);
        }
        console.log(`${this.logTag}Approved ${symbol}`);
      }
    }
  }

  /**
   * Log and record liquidator's token balances (debt tokens + WBTC)
   */
  async logBalances(): Promise<void> {
    const liquidator = this.walletClient.account.address;

    console.log(`${this.logTag}Token balances:`);

    // Debt tokens — symbol/decimals are immutable, fetched once and cached.
    // Kick metadata + balanceOf in parallel so cold-start matches the original
    // 3-RPC concurrency; subsequent cycles only fire balanceOf (cache hit).
    for (const tokenAddress of this.debtTokenAddresses) {
      const [{ symbol, decimals }, balance] = await Promise.all([
        this.getTokenMeta(tokenAddress),
        readBalance(this.publicClient, tokenAddress, liquidator),
      ]);

      this.metrics.recordTokenBalance(symbol, tokenAddress, balance, decimals);
      console.log(`   ${symbol}: ${formatUnits(balance, decimals)}`);
    }

    // WBTC balance
    const [{ symbol: wbtcSymbol, decimals: wbtcDecimals }, wbtcBalance] = await Promise.all([
      this.getTokenMeta(this.wbtcAddress),
      readBalance(this.publicClient, this.wbtcAddress, liquidator),
    ]);

    this.metrics.recordTokenBalance(wbtcSymbol, this.wbtcAddress, wbtcBalance, wbtcDecimals);
    console.log(`   ${wbtcSymbol}: ${formatUnits(wbtcBalance, wbtcDecimals)}`);
  }
}
