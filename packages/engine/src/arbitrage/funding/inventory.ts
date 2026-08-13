import { vaultSwapAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import type { TokenSpend } from "@repo/risk";
import type { Hex } from "viem";
import type { AllowanceResult } from "../../shared/executor";
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
    const balance = await readBalance(publicClient, wbtcAddress, owner);
    risk.setAvailable({ owner, token: wbtcAddress }, balance);
    // No allowance leg: the signer spends its own balance, with nothing to approve.
    metrics.recordFundingCapacity({ owner, balance });
  }

  /**
   * The LLP pulls the WBTC from the signer, so the signer must have approved it.
   *
   * AUTO broadcasts the approval and waits, so it only ever returns `satisfied`. MANUAL proposes it
   * for an operator to sign and returns `proposed`/`duplicate` — the swap cannot go out until they
   * do.
   */
  ensureFunded(maxWbtcIn: bigint): Promise<AllowanceResult> {
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
    const target = { address: this.deps.vaultSwapAddress, abi: vaultSwapAbi };
    // No `authorizationId`: the signer pays with the transaction, so nothing outlives it.
    return {
      call: this.deps.vaultKeeperAddress
        ? {
            ...target,
            functionName: "swapWbtcForVaultOnBehalf",
            args: [vaultId, maxWbtcIn, this.deps.vaultKeeperAddress],
          }
        : { ...target, functionName: "swapWbtcForVault", args: [vaultId, maxWbtcIn] },
    };
  }
}
