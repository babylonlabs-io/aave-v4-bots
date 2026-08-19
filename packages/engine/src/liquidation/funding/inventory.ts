import { adapterAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  maxUint256,
} from "viem";
import { retireSettledOutflows } from "../../shared/outflows";
import { sequentialPriorityOrder } from "../domain";
import type {
  FundedCandidate,
  FundingContext,
  LiquidationCandidate,
  LiquidationFunding,
} from "./types";

/**
 * Repay from the signer's own inventory, through `AaveAdapter`.
 *
 * Everything here follows from that one fact: the signer's tokens are what pays, so the adapter
 * needs an allowance, the gate needs to know the balances, and each action must declare what it
 * will pull. None of it applies to flash funding, which is why it lives here rather than on the
 * engine — it was engine state only for as long as this was the only way to fund a liquidation.
 */
/** Named so the compiler enforces that inventory funding touches only what it needs. */
export type InventoryFundingDeps = Pick<
  FundingContext,
  | "publicClient"
  | "adapterAddress"
  | "llpAddress"
  | "btcRedeemKey"
  | "isDirectRedemption"
  | "wbtcAddress"
  | "debtTokens"
  | "executor"
  | "tokenMeta"
  | "risk"
  | "logger"
  | "metrics"
>;

export class InventoryFunding implements LiquidationFunding {
  readonly mode = "inventory" as const;

  constructor(private readonly deps: InventoryFundingDeps) {}

  /** Nothing to do at boot: the approvals this mode needs are sent from `refreshInventory`. */
  async prepare(): Promise<void> {}

  /** Approve the adapter to pull every debt token plus WBTC. */
  private async approveAdapter(): Promise<void> {
    const { adapterAddress, wbtcAddress, executor, logger } = this.deps;
    const tokens = Array.from(new Set<Address>([...this.deps.debtTokens(), wbtcAddress]));

    for (const token of tokens) {
      const { symbol } = await this.deps.tokenMeta.get(this.deps.publicClient, token);
      const result = await executor.ensureAllowance({
        token,
        spender: adapterAddress,
        required: maxUint256 / 2n,
        label: symbol,
      });
      // MANUAL: `proposed` (fresh) or `duplicate` (already awaiting) means the allowance is not
      // ready — the operator must sign it. AUTO only ever returns `satisfied` (it throws on a
      // reverted approve). The cycle's simulation gates dependent actions until it clears.
      if (result.kind !== "satisfied") {
        logger.info(`Approval for ${symbol} ${result.kind} — awaiting operator signature`);
      }
    }
  }

  /**
   * Tell the risk gate what this signer can currently spend, for every token an action may pull.
   *
   * Must not swallow read errors: the gate fails closed on a token it has no figure for, so a
   * silent failure would present as "everything is unaffordable" rather than "we could not read".
   */
  async refreshInventory(): Promise<void> {
    // Before the balances, because an allowance the adapter cannot pull makes them meaningless —
    // and because this is the first point in the cycle that is downstream of the gate's HALTED
    // check, so it is the earliest place an approval may legitimately be sent.
    await this.approveAdapter();

    const { publicClient, wbtcAddress, risk, executor } = this.deps;
    const owner = executor.identity.from;
    const tokens = Array.from(new Set<Address>([...this.deps.debtTokens(), wbtcAddress]));

    // Every balance in this refresh is read at one height, and that height is what the gate's
    // outflow holds are judged against: a hold is only retired by evidence that this read already
    // accounts for it. Unpinned reads could not support that comparison — each would be "latest"
    // at a different moment, and two engines publishing the same account would race.
    const block = await publicClient.getBlockNumber();
    const balances = await Promise.all(
      tokens.map((token) => readBalance(publicClient, token, owner, block))
    );
    await retireSettledOutflows({ publicClient, risk, executor, block });

    // Synchronous from here: retiring a hold and publishing the read that covers it must not be
    // separated by an await, or the other engine can be judged in between — against a balance that
    // has dropped the hold and not yet gained the spend it was holding.
    for (let i = 0; i < tokens.length; i++) {
      risk.setAvailable({ owner, token: tokens[i] }, balances[i], block);
    }
  }

  /** Viable iff the adapter call simulates from the signer's balances. */
  async vet(candidates: readonly LiquidationCandidate[]): Promise<FundedCandidate[]> {
    const { logger, metrics } = this.deps;

    const simulations = await Promise.allSettled(
      candidates.map((candidate) =>
        this.deps.publicClient.simulateContract({
          ...(this.call(candidate) as Parameters<PublicClient["simulateContract"]>[0]),
          account: this.deps.executor.identity.from,
        })
      )
    );

    const viable: FundedCandidate[] = [];
    for (let i = 0; i < simulations.length; i++) {
      const result = simulations[i];
      const candidate = candidates[i];
      if (result.status === "fulfilled") {
        viable.push({ ...candidate, call: this.call(candidate), risk: this.risk(candidate) });
      } else {
        metrics.recordSimulationFailed();
        const reason = result.reason;
        let errorMsg = "Unknown error";
        // The rejection is viem's ContractFunctionExecutionError, which carries the
        // ContractFunctionRevertedError on its cause chain rather than being one — so this has to
        // walk to reach the decoded name instead of testing `reason` itself.
        const revert =
          reason instanceof BaseError
            ? reason.walk((e) => e instanceof ContractFunctionRevertedError)
            : null;
        if (revert instanceof ContractFunctionRevertedError) {
          errorMsg = revert.data?.errorName || revert.shortMessage;
        } else if (reason instanceof Error) {
          errorMsg = reason.message;
        }
        logger.warn(`Simulation failed for ${candidate.position.proxyAddress}: ${errorMsg}`);
      }
    }
    return viable;
  }

  /** The adapter call — the same description simulated above and committed later. */
  private call(candidate: LiquidationCandidate): ContractCall {
    const { position, amounts } = candidate;
    // Sequential priority order per candidate (each may have a different reserve count).
    const priorityOrder = sequentialPriorityOrder(amounts.length);
    const { adapterAddress, btcRedeemKey, llpAddress, isDirectRedemption } = this.deps;

    return isDirectRedemption
      ? {
          address: adapterAddress,
          abi: adapterAbi,
          functionName: "liquidate",
          args: [position.borrower, btcRedeemKey, [...amounts], [...priorityOrder], 0n, maxUint256],
        }
      : {
          address: adapterAddress,
          abi: adapterAbi,
          functionName: "liquidateWithLLP",
          args: [position.borrower, llpAddress, [...amounts], [...priorityOrder], []],
        };
  }

  /**
   * Everything this tx can pull from the signer: the buffered repay amounts (one per debt reserve,
   * in that reserve's token) plus the adapter's WBTC payment. Declared so the arbitrage engine
   * sharing this signer cannot commit the same balance to a vault.
   *
   * No `expectedProfit`: liquidation profit is not derivable off-chain on this path. The Lens
   * returns debt amounts and vault *ids*, and `liquidate`/`liquidateWithLLP` return only `vaultIds`,
   * so nothing yields a WBTC-denominated figure. The gate skips its profit floor when it is
   * undefined — which is why a profit floor is rejected outright for an inventory-funded engine.
   */
  private risk(candidate: LiquidationCandidate): FundedCandidate["risk"] {
    const debtTokens = this.deps.debtTokens();
    // Inventory funding spends the signer's own tokens, so it is both the payer and the account
    // the gate reserves against.
    const owner = this.deps.executor.identity.from;
    return {
      spend: [
        ...candidate.amounts.map((amount, idx) => ({
          owner,
          token: debtTokens[idx] ?? this.deps.wbtcAddress,
          amount,
        })),
        { owner, token: this.deps.wbtcAddress, amount: candidate.wbtcPayment },
      ],
    };
  }
}
