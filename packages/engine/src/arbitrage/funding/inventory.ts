import { erc20Abi, vaultSwapAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import { type ContractCall, buildMultiSendCall, readMultiSendCallOnlyCode } from "@repo/execution";
import type { TokenSpend } from "@repo/risk";
import type { Hex } from "viem";
import type { AllowanceResult } from "../../shared/executor";
import { settledOutflows } from "../../shared/outflows";
import type { AcquisitionCall, ArbitrageFunding, FundingContext } from "./types";

type Deps = Pick<
  FundingContext,
  | "publicClient"
  | "risk"
  | "metrics"
  | "executor"
  | "wbtcAddress"
  | "vaultSwapAddress"
  | "vaultKeeperAddress"
>;

/**
 * The signer pays for its own acquisitions out of its own WBTC.
 *
 * Payer and signer being one account is what makes this mode simple: the balance the gate reserves
 * against is the signer's, the allowance the LLP pulls through is the signer's, and both are
 * things this process can act on directly.
 */
export class InventoryFunding implements ArbitrageFunding {
  readonly mode = "inventory" as const;

  constructor(private deps: Deps) {}

  spend(maxWbtcIn: bigint): TokenSpend {
    return {
      owner: this.deps.executor.identity.from,
      token: this.deps.wbtcAddress,
      amount: maxWbtcIn,
    };
  }

  /** Nothing to verify: the account that pays is the one this process already signs with. */
  async prepare(): Promise<void> {}

  async refreshInventory(): Promise<void> {
    const { publicClient, risk, metrics, wbtcAddress, executor } = this.deps;
    const owner = executor.identity.from;
    // Pinned, and the holds retired against that same height — see the liquidation inventory mode,
    // and `settledOutflows` for what counts as evidence. This account is usually the one the
    // liquidation engine spends too, so both halves of this matter here: an outflow either engine
    // broadcast is held against the balance both of them read.
    const block = await publicClient.getBlockNumber();
    const balance = await readBalance(publicClient, wbtcAddress, owner, block);
    const settled = await settledOutflows({ publicClient, risk, executor, block });
    risk.applySnapshot(
      [{ account: { owner, token: wbtcAddress }, amount: balance }],
      block,
      settled
    );
    // No allowance leg: the signer spends its own balance, with nothing to approve.
    metrics.recordFundingCapacity({ owner, balance });
  }

  /** Take the LLP's WBTC allowance back to zero — the one standing permission this mode grants. */
  async revokeApprovals(): Promise<void> {
    const { executor, wbtcAddress, vaultSwapAddress } = this.deps;
    await executor.revokeAllowance({
      token: wbtcAddress,
      spender: vaultSwapAddress,
      label: "WBTC",
    });
  }

  /**
   * A MANUAL Safe approves inside the acquisition's own SafeTx (see `buildAcquisition`), so it
   * never holds a standing allowance and the owners sign one transaction per vault.
   */
  private batchesApproval(): boolean {
    const { executor } = this.deps;
    return executor.mode === "MANUAL" && executor.executorKind === "safe";
  }

  /**
   * The LLP pulls the WBTC from the signer, so the signer must have approved it.
   *
   * AUTO broadcasts the approval and waits, so it only ever returns `satisfied`. MANUAL proposes it
   * for an operator to sign and returns `proposed`/`duplicate` — the swap cannot go out until they
   * do. A MANUAL Safe needs nothing first: the approval travels in the acquisition's batch.
   */
  ensureFunded(maxWbtcIn: bigint): Promise<AllowanceResult> {
    if (this.batchesApproval()) return Promise.resolve({ kind: "satisfied" });
    return this.deps.executor.ensureAllowance({
      token: this.deps.wbtcAddress,
      spender: this.deps.vaultSwapAddress,
      required: maxWbtcIn,
      label: "WBTC",
    });
  }

  /** Nothing to expire: the transaction is the authorization. */
  async authorizationExpired(): Promise<boolean> {
    return false;
  }

  /** Never: the payment and the transaction are the same thing, so a failed one moved nothing. */
  async spentWithoutUs(): Promise<boolean> {
    return false;
  }

  /** Nothing to settle: no authorization exists apart from the transaction itself. */
  settleAuthorization(): void {}

  async buildAcquisition({
    vaultId,
    maxWbtcIn,
  }: { vaultId: Hex; maxWbtcIn: bigint }): Promise<AcquisitionCall> {
    const { publicClient, executor, wbtcAddress, vaultSwapAddress, vaultKeeperAddress } = this.deps;
    const target = { address: vaultSwapAddress, abi: vaultSwapAbi };
    const swap: ContractCall = vaultKeeperAddress
      ? {
          ...target,
          functionName: "swapExitBtcForVaultOnBehalf",
          args: [vaultId, maxWbtcIn, vaultKeeperAddress],
        }
      : { ...target, functionName: "swapExitBtcForVault", args: [vaultId, maxWbtcIn] };
    // No `authorizationId`: the signer pays with the transaction, so nothing outlives it.
    if (!this.batchesApproval()) return { call: swap };

    // Approve exactly the ceiling, buy, then reset to zero: the swap pulls at most `maxWbtcIn`, and
    // the trailing approve leaves no allowance behind, whatever the vault actually cost.
    const approve = (amount: bigint): ContractCall => ({
      address: wbtcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultSwapAddress, amount],
    });
    const code = await readMultiSendCallOnlyCode(publicClient);
    return {
      call: buildMultiSendCall([approve(maxWbtcIn), swap, approve(0n)]),
      // Run the batch as the Safe would: MultiSendCallOnly's code at the Safe's address.
      estimateStateOverride: [{ address: executor.identity.from, code }],
    };
  }
}
