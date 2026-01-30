import {
  type Account,
  type Address,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  decodeEventLog,
  formatUnits,
  parseAbiItem,
} from "viem";

import { controllerAbi, erc20Abi, spokeAbi, vaultSwapAbi } from "@repo/shared";
import {
  recordError,
  recordLiquidationFailed,
  recordLiquidationSuccess,
  recordPollDuration,
  recordPositionsChecked,
  recordPositionsLiquidatable,
  recordSimulationFailed,
  recordTokenBalance,
  recordVaultSwapped,
  recordVaultsSeized,
  recordWbtcReceived,
} from "./metrics";
import type { LiquidatablePosition, PonderResponse } from "./types";

// Event for parsing vault transfers from liquidation logs
const vaultOwnershipTransferredEvent = parseAbiItem(
  "event VaultOwnershipTransferred(bytes32 indexed vaultId, address indexed previousOwner, address indexed newOwner)"
);

// Maximum time to wait for a tx receipt before giving up (ms)
const TX_RECEIPT_TIMEOUT = 60_000;

export interface LiquidationBotConfig {
  logTag: string;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  controllerAddress: Address;
  vaultSwapAddress: Address;
  debtTokenAddresses?: Address[];
  wbtcAddress: Address;
  ponderUrl: string;
  autoSwap: boolean;
}

export class LiquidationBot {
  private logTag: string;
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClient: PublicClient;
  private controllerAddress: Address;
  private vaultSwapAddress: Address;
  private debtTokenAddresses: Address[];
  private wbtcAddress: Address;
  private ponderUrl: string;
  private autoSwap: boolean;

  constructor(config: LiquidationBotConfig) {
    this.logTag = config.logTag;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
    this.controllerAddress = config.controllerAddress;
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.debtTokenAddresses = config.debtTokenAddresses ?? [];
    this.wbtcAddress = config.wbtcAddress;
    this.ponderUrl = config.ponderUrl;
    this.autoSwap = config.autoSwap;
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
   * Simulates all candidates in parallel, then batch-sends valid liquidations.
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

      // 2. Simulate all liquidations in parallel to filter to valid ones
      const simulationResults = await Promise.allSettled(
        positions.map((p) =>
          this.publicClient.simulateContract({
            address: this.controllerAddress,
            abi: controllerAbi,
            functionName: "liquidateCorePosition",
            args: [p.proxyAddress],
            account: this.walletClient.account,
          })
        )
      );

      const validPositions: LiquidatablePosition[] = [];
      for (let i = 0; i < simulationResults.length; i++) {
        const result = simulationResults[i];
        const pos = positions[i];
        if (result.status === "fulfilled") {
          validPositions.push(pos);
        } else {
          recordSimulationFailed();
          const reason = result.reason;
          let errorMsg = "Unknown error";
          if (reason instanceof ContractFunctionRevertedError) {
            errorMsg = reason.data?.errorName || reason.message;
          } else if (reason instanceof Error) {
            errorMsg = reason.message;
          }
          console.warn(`${this.logTag}Simulation failed for ${pos.proxyAddress}: ${errorMsg}`);
        }
      }

      if (validPositions.length === 0) {
        console.log(`${this.logTag}No positions passed simulation`);
        return;
      }

      console.log(
        `${this.logTag}${validPositions.length}/${positions.length} positions passed simulation`
      );

      // 4. Send all liquidation txs with explicit nonces
      const nonce = await this.publicClient.getTransactionCount({
        address: this.walletClient.account.address,
        blockTag: "pending",
      });

      const txHashes: Hex[] = [];
      for (let i = 0; i < validPositions.length; i++) {
        const pos = validPositions[i];
        try {
          const hash = await this.walletClient.writeContract({
            address: this.controllerAddress,
            abi: controllerAbi,
            functionName: "liquidateCorePosition",
            args: [pos.proxyAddress],
            nonce: nonce + i,
          });
          console.log(`${this.logTag}Sent liquidation for ${pos.proxyAddress}: ${hash}`);
          txHashes.push(hash);
        } catch (error) {
          recordError("tx_send_error");
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          console.error(
            `${this.logTag}Failed to send liquidation for ${pos.proxyAddress}: ${errorMsg}`
          );
        }
      }

      if (txHashes.length === 0) {
        console.log(`${this.logTag}No liquidation txs were sent`);
        return;
      }

      // 5. Batch-wait for all receipts
      console.log(`${this.logTag}Waiting for ${txHashes.length} liquidation receipt(s)...`);
      const receipts = await Promise.allSettled(
        txHashes.map((hash) =>
          this.publicClient.waitForTransactionReceipt({ hash, timeout: TX_RECEIPT_TIMEOUT })
        )
      );

      // 6. Collect seized vault IDs from successful receipts
      const allSeizedVaultIds: Hex[] = [];
      for (let i = 0; i < receipts.length; i++) {
        const result = receipts[i];
        if (result.status === "fulfilled") {
          const receipt = result.value;
          if (receipt.status === "success") {
            recordLiquidationSuccess();
            console.log(
              `${this.logTag}Liquidation confirmed in block ${receipt.blockNumber}: ${txHashes[i]}`
            );
            const vaultIds = this.parseSeizedVaultIds(receipt.logs);
            allSeizedVaultIds.push(...vaultIds);
          } else {
            recordLiquidationFailed();
            recordError("tx_reverted");
            console.error(`${this.logTag}Liquidation reverted: ${txHashes[i]}`);
          }
        } else {
          recordLiquidationFailed();
          recordError("tx_reverted");
          console.error(`${this.logTag}Failed to get receipt for ${txHashes[i]}: ${result.reason}`);
        }
      }

      // Record seized vaults
      if (allSeizedVaultIds.length > 0) {
        recordVaultsSeized(allSeizedVaultIds.length);
      }

      // 7. Swap seized vaults for WBTC (if auto-swap enabled)
      if (allSeizedVaultIds.length > 0) {
        if (this.autoSwap) {
          await this.swapSeizedVaultsForWbtc(allSeizedVaultIds);
        } else {
          console.log(
            `${this.logTag}Auto-swap disabled. Seized ${allSeizedVaultIds.length} vault(s):`
          );
          for (const vaultId of allSeizedVaultIds) {
            console.log(`   ${vaultId}`);
          }
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
      const response = await fetch(`${this.ponderUrl}/liquidatable-positions`);

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

        if (decoded.eventName === "VaultOwnershipTransferred") {
          const args = decoded.args as {
            vaultId: Hex;
            previousOwner: Address;
            newOwner: Address;
          };
          if (args.newOwner.toLowerCase() === liquidator) {
            seizedVaultIds.push(args.vaultId);
            console.log(`${this.logTag}  Seized vault: ${args.vaultId}`);
          }
        }
      } catch {
        // Not a VaultOwnershipTransferred event, skip
      }
    }

    return seizedVaultIds;
  }

  /**
   * Swap all seized vaults for WBTC using parallel tx submission
   */
  private async swapSeizedVaultsForWbtc(vaultIds: Hex[]): Promise<void> {
    if (vaultIds.length === 0) {
      return;
    }

    const liquidator = this.walletClient.account.address;

    const wbtcBalanceBefore = await this.publicClient.readContract({
      address: this.wbtcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [liquidator],
    });

    console.log(`${this.logTag}Swapping ${vaultIds.length} vault(s) for WBTC...`);
    console.log(`   WBTC balance before: ${formatUnits(wbtcBalanceBefore, 8)} WBTC`);

    // Send all swap txs with explicit nonces
    const nonce = await this.publicClient.getTransactionCount({
      address: liquidator,
      blockTag: "pending",
    });

    const swapHashes: Hex[] = [];
    for (let i = 0; i < vaultIds.length; i++) {
      try {
        const hash = await this.walletClient.writeContract({
          address: this.vaultSwapAddress,
          abi: vaultSwapAbi,
          functionName: "swapVaultForWbtc",
          args: [vaultIds[i]],
          nonce: nonce + i,
        });
        swapHashes.push(hash);
      } catch (error) {
        recordError("swap_error");
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        console.error(`${this.logTag}  Failed to send swap for vault ${vaultIds[i]}: ${errorMsg}`);
      }
    }

    // Batch-wait for all swap receipts
    if (swapHashes.length > 0) {
      const swapReceipts = await Promise.allSettled(
        swapHashes.map((hash) =>
          this.publicClient.waitForTransactionReceipt({ hash, timeout: TX_RECEIPT_TIMEOUT })
        )
      );

      for (let i = 0; i < swapReceipts.length; i++) {
        const result = swapReceipts[i];
        if (result.status === "fulfilled" && result.value.status === "success") {
          recordVaultSwapped();
          console.log(`${this.logTag}  Vault swap confirmed: ${swapHashes[i]}`);
        } else {
          recordError("swap_error");
          console.error(`${this.logTag}  Vault swap failed: ${swapHashes[i]}`);
        }
      }
    }

    const wbtcBalanceAfter = await this.publicClient.readContract({
      address: this.wbtcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [liquidator],
    });

    const totalWbtcReceived = wbtcBalanceAfter - wbtcBalanceBefore;
    if (totalWbtcReceived > 0n) {
      recordWbtcReceived(totalWbtcReceived);
    }
    console.log(`${this.logTag}Swap complete!`);
    console.log(`   WBTC balance after: ${formatUnits(wbtcBalanceAfter, 8)} WBTC`);
    console.log(`   Total WBTC received: ${formatUnits(totalWbtcReceived, 8)} WBTC`);
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

        await this.publicClient.waitForTransactionReceipt({ hash, timeout: TX_RECEIPT_TIMEOUT });
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

  /**
   * List all vaults owned by the liquidator (from Ponder indexer)
   */
  async listOwnedVaults(): Promise<void> {
    const owner = this.walletClient.account.address.toLowerCase();
    const url = `${this.ponderUrl}/owned-vaults?owner=${owner}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Ponder API error: ${response.status}`);
      }

      const data = await response.json();
      const vaults = data.vaults as Array<{
        vaultId: string;
        owner: string;
        previousOwner: string;
        updatedAt: string;
      }>;

      if (vaults.length === 0) {
        console.log(`${this.logTag}No vaults owned by ${owner}`);
        return;
      }

      console.log(`${this.logTag}Owned vaults (${vaults.length}):`);
      console.log(
        "  VaultId                                                            | Previous Owner                             | Updated At"
      );
      console.log(`  ${"-".repeat(96)}`);
      for (const v of vaults) {
        console.log(`  ${v.vaultId} | ${v.previousOwner} | ${v.updatedAt}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error(`${this.logTag}Failed to list owned vaults: ${msg}`);
    }
  }

  /**
   * Swap a single vault for WBTC via the VaultSwap contract
   */
  async swapSingleVault(vaultId: Hex): Promise<void> {
    const liquidator = this.walletClient.account.address;

    const wbtcBefore = await this.publicClient.readContract({
      address: this.wbtcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [liquidator],
    });

    console.log(`${this.logTag}Swapping vault ${vaultId} for WBTC...`);
    console.log(`   WBTC balance before: ${formatUnits(wbtcBefore, 8)}`);

    try {
      const hash = await this.walletClient.writeContract({
        address: this.vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "swapVaultForWbtc",
        args: [vaultId],
      });

      console.log(`${this.logTag}Swap tx sent: ${hash}`);
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: TX_RECEIPT_TIMEOUT,
      });

      if (receipt.status === "success") {
        const wbtcAfter = await this.publicClient.readContract({
          address: this.wbtcAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [liquidator],
        });

        const received = wbtcAfter - wbtcBefore;
        console.log(`${this.logTag}Swap confirmed in block ${receipt.blockNumber}`);
        console.log(`   WBTC balance after: ${formatUnits(wbtcAfter, 8)}`);
        console.log(`   WBTC received: ${formatUnits(received, 8)}`);
      } else {
        console.error(`${this.logTag}Swap tx reverted: ${hash}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error(`${this.logTag}Swap failed: ${msg}`);
    }
  }
}
