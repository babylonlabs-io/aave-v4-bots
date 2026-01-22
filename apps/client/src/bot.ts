import {
  type Account,
  type Address,
  type Chain,
  ContractFunctionRevertedError,
  type Transport,
  type WalletClient,
  type PublicClient,
  type Hex,
  formatUnits,
  decodeEventLog,
  parseAbiItem,
} from "viem";

import { aaveIntegrationControllerAbi, erc20Abi } from "./abis/AaveIntegrationController";
import { vaultSwapAbi } from "./abis/VaultSwap";
import type { LiquidatablePosition, PonderResponse } from "./types";

// Event for parsing vault transfers from liquidation logs
const vaultOwnershipTransferredEvent = parseAbiItem(
  "event VaultOwnershipTransferred(bytes32 indexed vaultId, address indexed previousOwner, address indexed newOwner)"
);

export interface LiquidationBotConfig {
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  controllerAddress: Address;
  vaultSwapAddress: Address;
  debtTokenAddress: Address;
  wbtcAddress: Address;
  ponderUrl: string;
}

export class LiquidationBot {
  private logTag: string;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private controllerAddress: Address;
  private vaultSwapAddress: Address;
  private debtTokenAddress: Address;
  private wbtcAddress: Address;
  private ponderUrl: string;

  constructor(config: LiquidationBotConfig) {
    this.logTag = config.logTag;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.controllerAddress = config.controllerAddress;
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.debtTokenAddress = config.debtTokenAddress;
    this.wbtcAddress = config.wbtcAddress;
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
        functionName: "liquidateCorePosition",
        args: [proxyAddress],
      });

      console.log(`${this.logTag}✅ Liquidation transaction sent: ${hash}`);

      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

      if (receipt.status === "success") {
        console.log(`${this.logTag}✅ Liquidation confirmed in block ${receipt.blockNumber}`);

        // Parse logs to find which vault IDs were transferred to liquidator
        const seizedVaultIds = this.parseSeizedVaultIds(receipt.logs);
        console.log(`${this.logTag}Seized ${seizedVaultIds.length} vault(s)`);

        // Now swap each seized vault for WBTC
        await this.swapSeizedVaultsForWbtc(seizedVaultIds);

        return true;
      } else {
        console.error(`${this.logTag}❌ Liquidation transaction reverted`);
        console.error(`   TX Hash: ${hash}`);
        console.error(`   Block: ${receipt.blockNumber}`);

        // Try to get the revert reason by simulating the call
        try {
          await this.publicClient.simulateContract({
            address: this.controllerAddress,
            abi: aaveIntegrationControllerAbi,
            functionName: "liquidateCorePosition",
            args: [proxyAddress],
            account: this.walletClient.account,
          });
        } catch (simError) {
          if (simError instanceof ContractFunctionRevertedError) {
            console.error(`   Revert reason: ${simError.data?.errorName || simError.message}`);
          } else if (simError instanceof Error) {
            console.error(`   Simulation error: ${simError.message}`);
          }
        }

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
   * Parse VaultOwnershipTransferred events from transaction logs to get seized vault IDs
   */
  private parseSeizedVaultIds(logs: readonly { topics: readonly Hex[]; data: Hex }[]): Hex[] {
    const liquidator = this.walletClient.account.address.toLowerCase();
    const seizedVaultIds: Hex[] = [];

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [vaultOwnershipTransferredEvent],
          data: log.data,
          topics: [...log.topics] as [Hex, ...Hex[]],
        });

        // Check if this vault was transferred TO our liquidator
        if (decoded.eventName === "VaultOwnershipTransferred") {
          const args = decoded.args as { vaultId: Hex; previousOwner: Address; newOwner: Address };
          if (args.newOwner.toLowerCase() === liquidator) {
            seizedVaultIds.push(args.vaultId);
            console.log(`${this.logTag}   Seized vault: ${args.vaultId}`);
          }
        }
      } catch {
        // Not a VaultOwnershipTransferred event, skip
      }
    }

    return seizedVaultIds;
  }

  /**
   * Swap all seized vaults for WBTC
   */
  private async swapSeizedVaultsForWbtc(vaultIds: Hex[]): Promise<void> {
    if (vaultIds.length === 0) {
      console.log(`${this.logTag}No vaults to swap`);
      return;
    }

    const liquidator = this.walletClient.account.address;

    // Get WBTC balance before swaps
    const wbtcBalanceBefore = await this.publicClient.readContract({
      address: this.wbtcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [liquidator],
    });

    console.log(`${this.logTag}Swapping ${vaultIds.length} vault(s) for WBTC...`);
    console.log(`   WBTC balance before: ${formatUnits(wbtcBalanceBefore, 8)} WBTC`);

    let totalWbtcReceived = 0n;

    for (const vaultId of vaultIds) {
      try {
        console.log(`${this.logTag}   Swapping vault ${vaultId}...`);

        const hash = await this.walletClient.writeContract({
          address: this.vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "swapVaultForWbtc",
          args: [vaultId],
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

        if (receipt.status === "success") {
          console.log(`${this.logTag}   ✅ Vault ${vaultId} swapped successfully`);
        } else {
          console.error(`${this.logTag}   ❌ Swap failed for vault ${vaultId}`);
        }
      } catch (error) {
        let errorMsg = "Unknown error";
        if (error instanceof ContractFunctionRevertedError) {
          errorMsg = `${error.data?.errorName || "Contract reverted"}`;
        } else if (error instanceof Error) {
          errorMsg = error.message;
        }
        console.error(`${this.logTag}   ❌ Failed to swap vault ${vaultId}: ${errorMsg}`);
      }
    }

    // Get WBTC balance after swaps
    const wbtcBalanceAfter = await this.publicClient.readContract({
      address: this.wbtcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [liquidator],
    });

    totalWbtcReceived = wbtcBalanceAfter - wbtcBalanceBefore;

    console.log(`${this.logTag}✅ Swap complete!`);
    console.log(`   WBTC balance after: ${formatUnits(wbtcBalanceAfter, 8)} WBTC`);
    console.log(`   Total WBTC received: ${formatUnits(totalWbtcReceived, 8)} WBTC`);
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
