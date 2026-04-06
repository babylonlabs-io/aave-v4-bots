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

import {
  type RetryConfig,
  controllerAbi,
  erc20Abi,
  fetchWithRetry,
  lensAbi,
  spokeAbi,
} from "@repo/shared";
import {
  recordError,
  recordLiquidationFailed,
  recordLiquidationSuccess,
  recordPollDuration,
  recordPositionsChecked,
  recordPositionsLiquidatable,
  recordSimulationFailed,
  recordTokenBalance,
} from "./metrics";
import type { LiquidatablePosition, PonderResponse } from "./types";

const DEFAULT_FETCH_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export interface LiquidationBotConfig {
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  controllerAddress: Address;
  lensAddress: Address;
  debtTokenAddresses?: Address[];
  wbtcAddress: Address;
  btcRedeemKey: Hex;
  isDirectRedemption: boolean;
  llpAddress: Address;
  ponderUrl: string;
  txReceiptTimeoutMs: number;
}

export class LiquidationBot {
  private logTag: string;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private controllerAddress: Address;
  private lensAddress: Address;
  private debtTokenAddresses: Address[];
  private wbtcAddress: Address;
  private btcRedeemKey: Hex;
  private isDirectRedemption: boolean;
  private llpAddress: Address;
  private ponderUrl: string;
  private txReceiptTimeoutMs: number;

  constructor(config: LiquidationBotConfig) {
    this.logTag = config.logTag;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.controllerAddress = config.controllerAddress;
    this.lensAddress = config.lensAddress;
    this.debtTokenAddresses = config.debtTokenAddresses ?? [];
    this.wbtcAddress = config.wbtcAddress;
    this.btcRedeemKey = config.btcRedeemKey;
    this.isDirectRedemption = config.isDirectRedemption;
    this.llpAddress = config.llpAddress;
    this.ponderUrl = config.ponderUrl;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs;
  }

  /**
   * Discover debt tokens from the Spoke contract's borrowable reserves.
   * Reads Spoke address from the Controller, then enumerates reserves.
   */
  async discoverDebtTokens(): Promise<void> {
    console.log(`${this.logTag}Discovering debt tokens from Spoke...`);

    const spokeAddress = await this.publicClient.readContract({
      address: this.controllerAddress,
      abi: controllerAbi,
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

      if (reserve.borrowable) {
        discovered.push(reserve.underlying);

        const symbol = await this.publicClient.readContract({
          address: reserve.underlying,
          abi: erc20Abi,
          functionName: "symbol",
        });

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

      recordPositionsLiquidatable(positions.length);

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

      // 3. Build position + inputs pairs, filter failed estimates
      const candidates: Array<{
        position: LiquidatablePosition;
        inputs: readonly { token: Address; amount: bigint }[];
      }> = [];

      for (let i = 0; i < estimateResults.length; i++) {
        const result = estimateResults[i];
        const pos = positions[i];

        if (result.status === "fulfilled") {
          const [inputs] = result.value;
          candidates.push({ position: pos, inputs });
        } else {
          recordError("lens_estimate_error");
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
        candidates.map(({ position, inputs }) =>
          this.isDirectRedemption
            ? this.publicClient.simulateContract({
                address: this.controllerAddress,
                abi: controllerAbi,
                functionName: "liquidate",
                args: [position.borrower, this.btcRedeemKey, inputs],
                account: this.walletClient.account,
              })
            : this.publicClient.simulateContract({
                address: this.controllerAddress,
                abi: controllerAbi,
                functionName: "liquidateWithLLP",
                args: [position.borrower, this.llpAddress, inputs, []],
                account: this.walletClient.account,
              })
        )
      );

      const validCandidates: typeof candidates = [];
      for (let i = 0; i < simulationResults.length; i++) {
        const result = simulationResults[i];
        const candidate = candidates[i];
        if (result.status === "fulfilled") {
          validCandidates.push(candidate);
        } else {
          recordSimulationFailed();
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
      let nextNonce = await this.publicClient.getTransactionCount({
        address: this.walletClient.account.address,
        blockTag: "pending",
      });

      const txHashes: Hex[] = [];
      for (let i = 0; i < validCandidates.length; i++) {
        const { position, inputs } = validCandidates[i];
        try {
          const hash = this.isDirectRedemption
            ? await this.walletClient.writeContract({
                address: this.controllerAddress,
                abi: controllerAbi,
                functionName: "liquidate",
                args: [position.borrower, this.btcRedeemKey, inputs],
                nonce: nextNonce,
              })
            : await this.walletClient.writeContract({
                address: this.controllerAddress,
                abi: controllerAbi,
                functionName: "liquidateWithLLP",
                args: [position.borrower, this.llpAddress, inputs, []],
                nonce: nextNonce,
              });
          console.log(`${this.logTag}Sent liquidation for ${position.borrower}: ${hash}`);
          txHashes.push(hash);
          nextNonce += 1;
        } catch (error) {
          recordError("tx_send_error");
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          console.error(
            `${this.logTag}Failed to send liquidation for ${position.borrower}: ${errorMsg}`
          );
          try {
            nextNonce = await this.publicClient.getTransactionCount({
              address: this.walletClient.account.address,
              blockTag: "pending",
            });
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
            recordLiquidationSuccess();
            console.log(
              `${this.logTag}Liquidation confirmed in block ${receipt.blockNumber}: ${txHashes[i]}`
            );
          } else {
            recordLiquidationFailed();
            recordError("tx_reverted");
            console.error(`${this.logTag}Liquidation reverted: ${txHashes[i]}`);
          }
        } else {
          recordLiquidationFailed();
          recordError("receipt_fetch_error");
          console.error(`${this.logTag}Failed to get receipt for ${txHashes[i]}: ${result.reason}`);
        }
      }
    } catch (error) {
      recordError("poll_error");
      console.error(`${this.logTag}Error in bot run:`, error);
    } finally {
      recordPollDuration(Date.now() - startTime);
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
      recordPositionsChecked(data.checked);
      return data.liquidatable;
    } catch (error) {
      recordError("ponder_fetch_error");
      console.error(`${this.logTag}Failed to fetch liquidatable positions:`, error);
      return [];
    }
  }

  /**
   * Ensure liquidator has approved Controller to spend all debt tokens
   */
  async ensureApproval(): Promise<void> {
    const liquidator = this.walletClient.account.address;
    const maxApproval = BigInt(
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );

    for (const tokenAddress of this.debtTokenAddresses) {
      const allowance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [liquidator, this.controllerAddress],
      });

      if (allowance < maxApproval / 2n) {
        const symbol = await this.publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "symbol",
          args: [],
        });

        console.log(`${this.logTag}Approving ${symbol} for Controller...`);

        const hash = await this.walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.controllerAddress, maxApproval],
        });

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

    // Debt tokens
    for (const tokenAddress of this.debtTokenAddresses) {
      const [balance, symbol, decimals] = await Promise.all([
        this.publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [liquidator],
        }),
        this.publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "symbol",
          args: [],
        }),
        this.publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "decimals",
          args: [],
        }),
      ]);

      recordTokenBalance(symbol, tokenAddress, balance, decimals);
      console.log(`   ${symbol}: ${formatUnits(balance, decimals)}`);
    }

    // WBTC balance
    const [wbtcBalance, wbtcSymbol] = await Promise.all([
      this.publicClient.readContract({
        address: this.wbtcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [liquidator],
      }),
      this.publicClient.readContract({
        address: this.wbtcAddress,
        abi: erc20Abi,
        functionName: "symbol",
        args: [],
      }),
    ]);

    recordTokenBalance(wbtcSymbol, this.wbtcAddress, wbtcBalance, 8);
    console.log(`   ${wbtcSymbol}: ${formatUnits(wbtcBalance, 8)}`);
  }
}
