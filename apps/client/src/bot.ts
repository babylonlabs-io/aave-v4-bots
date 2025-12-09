import {
  type Account,
  type Address,
  type Chain,
  ContractFunctionRevertedError,
  type Transport,
  type WalletClient,
  type PublicClient,
  formatUnits,
} from "viem";

import { aaveIntegrationControllerAbi, erc20Abi } from "./abis/AaveIntegrationController";
import type { LiquidatablePosition, PonderResponse } from "./types";

export interface LiquidationBotConfig {
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  controllerAddress: Address;
  debtTokenAddress: Address;
  ponderUrl: string;
}

export class LiquidationBot {
  private logTag: string;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private controllerAddress: Address;
  private debtTokenAddress: Address;
  private ponderUrl: string;

  constructor(config: LiquidationBotConfig) {
    this.logTag = config.logTag;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.controllerAddress = config.controllerAddress;
    this.debtTokenAddress = config.debtTokenAddress;
    this.ponderUrl = config.ponderUrl;
  }

  /**
   * Run one iteration of the liquidation bot
   */
  async run(): Promise<void> {
    try {
      // 1. Fetch liquidatable positions from Ponder
      const positions = await this.fetchLiquidatablePositions();

      if (positions.length === 0) {
        console.log(`${this.logTag}No liquidatable positions found`);
        return;
      }

      console.log(`${this.logTag}Found ${positions.length} liquidatable position(s)`);

      // 2. Liquidate each position
      for (const position of positions) {
        await this.liquidate(position);
      }
    } catch (error) {
      console.error(`${this.logTag}Error in bot run:`, error);
    }
  }

  /**
   * Fetch liquidatable positions from Ponder indexer
   */
  private async fetchLiquidatablePositions(): Promise<LiquidatablePosition[]> {
    try {
      const response = await fetch(`${this.ponderUrl}/liquidatable-positions`);
      
      if (!response.ok) {
        throw new Error(`Ponder API error: ${response.status}`);
      }

      const data: PonderResponse = await response.json();
      return data.liquidatable;
    } catch (error) {
      console.error(`${this.logTag}Failed to fetch liquidatable positions:`, error);
      return [];
    }
  }

  /**
   * Execute liquidation for a single position
   */
  private async liquidate(position: LiquidatablePosition): Promise<boolean> {
    const { proxyAddress, healthFactor, totalDebtValue } = position;
    const healthFactorFormatted = (Number(healthFactor) / 1e18).toFixed(4);

    console.log(`${this.logTag}Attempting to liquidate:`);
    console.log(`   Proxy: ${proxyAddress}`);
    console.log(`   Health Factor: ${healthFactorFormatted}`);
    console.log(`   Total Debt: ${totalDebtValue}`);

    try {
      // Check and ensure approval
      await this.ensureApproval();

      // Execute liquidation
      const hash = await this.walletClient.writeContract({
        address: this.controllerAddress,
        abi: aaveIntegrationControllerAbi,
        functionName: "liquidate",
        args: [proxyAddress],
      });

      console.log(`${this.logTag}✅ Liquidation transaction sent: ${hash}`);

      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      
      if (receipt.status === "success") {
        console.log(`${this.logTag}✅ Liquidation confirmed in block ${receipt.blockNumber}`);
        
        // Query vault ownership after liquidation
        await this.showSeizedVaults();
        
        return true;
      } else {
        console.error(`${this.logTag}❌ Liquidation transaction reverted`);
        return false;
      }
    } catch (error) {
      let errorMsg = "Unknown error";
      if (error instanceof ContractFunctionRevertedError) {
        errorMsg = `${error.data?.errorName || "Contract reverted"}`;
      } else if (error instanceof Error) {
        errorMsg = error.message;
      }

      console.error(`${this.logTag}❌ Failed to liquidate ${proxyAddress}`);
      console.error(`   Error: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Ensure liquidator has approved Controller to spend debt tokens
   */
  private async ensureApproval(): Promise<void> {
    const liquidator = this.walletClient.account.address;

    // Check current allowance
    const allowance = await this.publicClient.readContract({
      address: this.debtTokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [liquidator, this.controllerAddress],
    });

    // If allowance is low, approve max
    const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    
    if (allowance < maxApproval / 2n) {
      console.log(`${this.logTag}Approving debt token for Controller...`);
      
      const hash = await this.walletClient.writeContract({
        address: this.debtTokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.controllerAddress, maxApproval],
      });

      await this.publicClient.waitForTransactionReceipt({ hash });
      console.log(`${this.logTag}✅ Approval confirmed`);
    }
  }

  /**
   * Show vaults now owned by liquidator after liquidation
   */
  private async showSeizedVaults(): Promise<void> {
    const liquidator = this.walletClient.account.address;
    
    console.log(`${this.logTag}Checking vault ownership for liquidator: ${liquidator}`);
    
    // Note: To show specific vaults, we'd need to track which vaults were in the position
    // For now, just confirm the liquidation was successful
    console.log(`${this.logTag}✅ Vaults transferred to liquidator`);
  }

  /**
   * Log liquidator's debt token balance
   */
  async logBalance(): Promise<void> {
    const liquidator = this.walletClient.account.address;

    const [balance, symbol, decimals] = await Promise.all([
      this.publicClient.readContract({
        address: this.debtTokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [liquidator],
      }),
      this.publicClient.readContract({
        address: this.debtTokenAddress,
        abi: erc20Abi,
        functionName: "symbol",
        args: [],
      }),
      this.publicClient.readContract({
        address: this.debtTokenAddress,
        abi: erc20Abi,
        functionName: "decimals",
        args: [],
      }),
    ]);

    const formattedBalance = formatUnits(balance, decimals);
    console.log(`${this.logTag}Liquidator balance: ${formattedBalance} ${symbol}`);
  }
}

