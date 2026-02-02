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

import {
  type RetryConfig,
  controllerAbi,
  erc20Abi,
  fetchWithRetry,
  vaultSwapAbi,
  withRetry,
} from "@repo/shared";
import { updateLastPollTime } from "./health";
import { recordError, recordPollDuration, recordVaultAcquired, recordWbtcBalance } from "./metrics";
import type { EscrowedVault, OwnedVault, PonderResponse } from "./types";

export interface ArbitrageurBotConfig {
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  controllerAddress: Address;
  vaultSwapAddress: Address;
  wbtcAddress: Address;
  ponderUrl: string;
  maxSlippageBps: number;
  autoRedeem: boolean;
  vaultProcessingDelayMs: number;
  retryConfig: RetryConfig;
  txReceiptTimeoutMs: number;
}

export class ArbitrageurBot {
  private logTag: string;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private controllerAddress: Address;
  private vaultSwapAddress: Address;
  private wbtcAddress: Address;
  private ponderUrl: string;
  private maxSlippageBps: number;
  private autoRedeem: boolean;
  private vaultProcessingDelayMs: number;
  private retryConfig: RetryConfig;
  private txReceiptTimeoutMs: number;

  // Local tracking of owned vaults
  private ownedVaults: Map<Hex, OwnedVault> = new Map();

  constructor(config: ArbitrageurBotConfig) {
    this.logTag = config.logTag;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.controllerAddress = config.controllerAddress;
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.wbtcAddress = config.wbtcAddress;
    this.ponderUrl = config.ponderUrl;
    this.maxSlippageBps = config.maxSlippageBps;
    this.autoRedeem = config.autoRedeem;
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
      // 1. Fetch escrowed vaults from Ponder
      const vaults = await this.fetchEscrowedVaults();

      if (vaults.length === 0) {
        console.log(`${this.logTag}No escrowed vaults available`);
        return;
      }

      console.log(`${this.logTag}Found ${vaults.length} escrowed vault(s)`);

      // 2. Process each vault one by one
      for (const vault of vaults) {
        const success = await this.acquireVault(vault);

        if (success && this.autoRedeem) {
          await this.redeemVault(vault.vaultId);
        }

        // Delay between processing vaults
        if (this.vaultProcessingDelayMs > 0) {
          await this.sleep(this.vaultProcessingDelayMs);
        }
      }
    } catch (error) {
      console.error(`${this.logTag}Error in bot run:`, error);
      recordError("poll_error");
    } finally {
      // Record poll duration and update last poll time
      const duration = Date.now() - startTime;
      recordPollDuration(duration);
      updateLastPollTime();
    }
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
      return data.vaults;
    } catch (error) {
      console.error(`${this.logTag}Failed to fetch escrowed vaults:`, error);
      recordError("ponder_fetch_error");
      return [];
    }
  }

  /**
   * Acquire a vault by swapping WBTC for it
   */
  async acquireVault(vault: EscrowedVault): Promise<boolean> {
    const { vaultId, btcAmount, currentDebt } = vault;
    const currentDebtBigInt = BigInt(currentDebt.replace("n", ""));
    const btcAmountBigInt = BigInt(btcAmount.replace("n", ""));

    console.log(`${this.logTag}Attempting to acquire vault:`);
    console.log(`   Vault ID: ${vaultId}`);
    console.log(`   BTC Amount: ${formatUnits(btcAmountBigInt, 8)} WBTC`);
    console.log(`   Current Debt: ${formatUnits(currentDebtBigInt, 8)} WBTC`);

    try {
      // Ensure WBTC approval for VaultSwap contract
      await this.ensureApproval(currentDebtBigInt);

      // Calculate maxWbtcIn with slippage buffer
      const slippageBuffer = (currentDebtBigInt * BigInt(this.maxSlippageBps)) / 10000n;
      const maxWbtcIn = currentDebtBigInt + slippageBuffer;

      console.log(
        `${this.logTag}Max WBTC willing to pay: ${formatUnits(maxWbtcIn, 8)} (${this.maxSlippageBps / 100}% slippage)`
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
        console.error(`${this.logTag}Gas estimation failed for vault ${vaultId}, skipping`);
        console.error(`   Error: ${errorMsg}`);
        recordError("gas_estimation_failed");
        return false;
      }

      // Execute swap via VaultSwap contract
      const hash = await this.walletClient.writeContract({
        address: this.vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "swapWbtcForVault",
        args: [vaultId as Hex, maxWbtcIn],
      });

      console.log(`${this.logTag}Swap transaction sent: ${hash}`);

      // Wait for confirmation with timeout
      const receipt = await this.waitForReceiptWithTimeout(hash, "swap");

      if (!receipt) {
        console.warn(`${this.logTag}Transaction receipt timeout for vault ${vaultId}`);
        recordError("tx_timeout");
        return false;
      }

      if (receipt.status === "success") {
        console.log(`${this.logTag}Vault acquired in block ${receipt.blockNumber}`);

        // Track locally
        this.ownedVaults.set(vaultId, {
          vaultId,
          acquiredAt: Date.now(),
          wbtcPaid: currentDebtBigInt, // approximate, actual may differ slightly
          btcAmount: btcAmountBigInt,
        });

        // Record metrics
        recordVaultAcquired(currentDebtBigInt);

        console.log(`${this.logTag}Total vaults owned this session: ${this.ownedVaults.size}`);

        return true;
      }
      console.error(`${this.logTag}Swap transaction reverted`);
      recordError("swap_reverted");
      return false;
    } catch (error) {
      let errorMsg = "Unknown error";
      if (error instanceof ContractFunctionRevertedError) {
        errorMsg = `${error.data?.errorName || "Contract reverted"}`;
        recordError("contract_revert");
      } else if (error instanceof Error) {
        errorMsg = error.message;
        recordError("acquire_error");
      }

      console.error(`${this.logTag}Failed to acquire vault ${vaultId}`);
      console.error(`   Error: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Redeem a vault to the arbitrageur's BTC key
   */
  async redeemVault(vaultId: Hex): Promise<boolean> {
    console.log(`${this.logTag}Attempting to redeem vault: ${vaultId}`);

    try {
      // Estimate gas first
      try {
        await this.publicClient.estimateContractGas({
          address: this.controllerAddress,
          abi: controllerAbi,
          functionName: "arbitrageurRedeem",
          args: [vaultId],
          account: this.walletClient.account,
        });
      } catch (gasError) {
        const errorMsg = gasError instanceof Error ? gasError.message : String(gasError);
        console.error(`${this.logTag}Gas estimation failed for redeem ${vaultId}, skipping`);
        console.error(`   Error: ${errorMsg}`);
        recordError("gas_estimation_failed");
        return false;
      }

      const hash = await this.walletClient.writeContract({
        address: this.controllerAddress,
        abi: controllerAbi,
        functionName: "arbitrageurRedeem",
        args: [vaultId],
      });

      console.log(`${this.logTag}Redeem transaction sent: ${hash}`);

      // Wait for confirmation with timeout
      const receipt = await this.waitForReceiptWithTimeout(hash, "redeem");

      if (!receipt) {
        console.warn(`${this.logTag}Transaction receipt timeout for redeem ${vaultId}`);
        recordError("tx_timeout");
        return false;
      }

      if (receipt.status === "success") {
        console.log(`${this.logTag}Vault redeemed in block ${receipt.blockNumber}`);

        // Remove from local tracking (vault is now redeemed)
        this.ownedVaults.delete(vaultId);

        return true;
      }
      console.error(`${this.logTag}Redeem transaction reverted`);
      recordError("redeem_reverted");
      return false;
    } catch (error) {
      let errorMsg = "Unknown error";
      if (error instanceof ContractFunctionRevertedError) {
        errorMsg = `${error.data?.errorName || "Contract reverted"}`;
        recordError("contract_revert");
      } else if (error instanceof Error) {
        errorMsg = error.message;
        recordError("redeem_error");
      }

      console.error(`${this.logTag}Failed to redeem vault ${vaultId}`);
      console.error(`   Error: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Wait for transaction receipt with timeout
   * Returns null if timeout exceeded instead of hanging forever
   */
  private async waitForReceiptWithTimeout(
    hash: Hex,
    txType: string
  ): Promise<Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>> | null> {
    try {
      const receipt = await Promise.race([
        this.publicClient.waitForTransactionReceipt({ hash }),
        this.createTimeout(this.txReceiptTimeoutMs),
      ]);

      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message === "Transaction receipt timeout") {
        console.warn(
          `${this.logTag}Timeout waiting for ${txType} transaction ${hash} after ${this.txReceiptTimeoutMs}ms`
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a timeout promise that rejects after the specified time
   */
  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Transaction receipt timeout")), ms);
    });
  }

  /**
   * Ensure arbitrageur has approved VaultSwap to spend WBTC
   */
  private async ensureApproval(requiredAmount: bigint): Promise<void> {
    const arbitrageur = this.walletClient.account.address;

    // Check current allowance for VaultSwap contract with retry
    const allowance = await withRetry(
      () =>
        this.publicClient.readContract({
          address: this.wbtcAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [arbitrageur, this.vaultSwapAddress],
        }),
      this.retryConfig,
      "allowance check"
    );

    // If allowance is insufficient, approve max
    if (allowance < requiredAmount) {
      console.log(`${this.logTag}Approving WBTC for VaultSwap...`);

      const hash = await this.walletClient.writeContract({
        address: this.wbtcAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.vaultSwapAddress, maxUint256],
      });

      const receipt = await this.waitForReceiptWithTimeout(hash, "approval");
      if (!receipt) {
        throw new Error("Approval transaction timed out");
      }
      console.log(`${this.logTag}Approval confirmed`);
    }
  }

  /**
   * Get all vaults owned by this arbitrageur (locally tracked)
   */
  getOwnedVaults(): OwnedVault[] {
    return Array.from(this.ownedVaults.values());
  }

  /**
   * Log summary of owned vaults
   */
  logOwnedVaults(): void {
    const vaults = this.getOwnedVaults();

    if (vaults.length === 0) {
      console.log(`${this.logTag}No vaults owned this session`);
      return;
    }

    console.log(`${this.logTag}Vaults owned this session: ${vaults.length}`);
    for (const vault of vaults) {
      console.log(`   - ${vault.vaultId}`);
      console.log(
        `     BTC: ${formatUnits(vault.btcAmount, 8)} | Paid: ${formatUnits(vault.wbtcPaid, 8)} WBTC`
      );
    }
  }

  /**
   * Log arbitrageur's WBTC balance
   */
  async logBalance(): Promise<void> {
    const arbitrageur = this.walletClient.account.address;

    try {
      const [balance, symbol, decimals] = await withRetry(
        () =>
          Promise.all([
            this.publicClient.readContract({
              address: this.wbtcAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [arbitrageur],
            }),
            this.publicClient.readContract({
              address: this.wbtcAddress,
              abi: erc20Abi,
              functionName: "symbol",
              args: [],
            }),
            this.publicClient.readContract({
              address: this.wbtcAddress,
              abi: erc20Abi,
              functionName: "decimals",
              args: [],
            }),
          ]),
        this.retryConfig,
        "balance check"
      );

      const formattedBalance = formatUnits(balance, decimals);
      console.log(`${this.logTag}Arbitrageur balance: ${formattedBalance} ${symbol}`);
      recordWbtcBalance(balance);
    } catch (error) {
      console.error(`${this.logTag}Failed to fetch balance:`, error);
    }
  }

  /**
   * Verify ownership of a vault on-chain
   */
  async verifyVaultOwnership(vaultId: Hex): Promise<boolean> {
    const arbitrageur = this.walletClient.account.address;

    const owner = await withRetry(
      () =>
        this.publicClient.readContract({
          address: this.controllerAddress,
          abi: controllerAbi,
          functionName: "getVaultOwner",
          args: [vaultId],
        }),
      this.retryConfig,
      "verify ownership"
    );

    return owner.toLowerCase() === arbitrageur.toLowerCase();
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
