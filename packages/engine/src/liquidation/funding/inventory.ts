import { adapterAbi } from "@repo/abis";
import { readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import type { TokenSpend } from "@repo/risk";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  maxUint256,
} from "viem";
import { retireSettledOutflows } from "../../shared/outflows";
import { sequentialPriorityOrder } from "../domain";
import { type SpokeReserves, borrowableTokens } from "../reserves";
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
  | "reserves"
  | "executor"
  | "tokenMeta"
  | "risk"
  | "logger"
  | "metrics"
>;

export class InventoryFunding implements LiquidationFunding {
  readonly mode = "inventory" as const;

  /**
   * The reserve list this cycle's balances were published against, read in `refreshInventory`.
   *
   * Per cycle rather than per candidate so a mid-cycle append cannot leave one liquidation
   * attributed against a list the others were not — and so the balances the gate holds and the
   * tokens the spends name always come from the same read.
   */
  private topology?: SpokeReserves;

  constructor(private readonly deps: InventoryFundingDeps) {}

  /** Nothing to do at boot: the approvals this mode needs are sent from `refreshInventory`. */
  async prepare(): Promise<void> {}

  /** Approve the adapter to pull every debt token plus WBTC. */
  private async approveAdapter(tokens: readonly Address[]): Promise<void> {
    const { adapterAddress, executor, logger } = this.deps;

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

  /** Take the adapter's allowance back to zero on every token this mode approves. */
  async revokeApprovals(): Promise<void> {
    const { adapterAddress, executor, logger } = this.deps;

    for (const token of await this.approvedTokens()) {
      const { symbol } = await this.deps.tokenMeta.get(this.deps.publicClient, token);
      try {
        const result = await executor.revokeAllowance({
          token,
          spender: adapterAddress,
          label: symbol,
        });
        // MANUAL cannot withdraw it itself, so the operator is told what is still standing.
        if (result.kind !== "satisfied") {
          logger.warn(`Revocation for ${symbol} ${result.kind} — awaiting operator signature`);
        }
      } catch (error) {
        // Per token, because the next one is a different allowance and a different transaction: a
        // revert or an RPC failure on this one is no reason to leave the rest granted.
        logger.error(`Could not revoke the adapter's ${symbol} allowance:`, error);
      }
    }
  }

  /**
   * The tokens this mode approves the adapter for: every borrowable reserve, plus WBTC.
   *
   * Read fresh when the cycle has not published a topology — `revokeApprovals` runs from a halted
   * cycle, which is exactly when no `refreshInventory` has been reached, and a bot that halted at
   * boot would otherwise have no list to withdraw against.
   */
  private async approvedTokens(): Promise<Address[]> {
    const topology = this.topology ?? (await this.deps.reserves());
    return Array.from(new Set<Address>([...borrowableTokens(topology), this.deps.wbtcAddress]));
  }

  /**
   * Tell the risk gate what this signer can currently spend, for every token an action may pull.
   *
   * Must not swallow read errors: the gate fails closed on a token it has no figure for, so a
   * silent failure would present as "everything is unaffordable" rather than "we could not read".
   */
  async refreshInventory(): Promise<void> {
    const { publicClient, wbtcAddress, risk, executor } = this.deps;
    const owner = executor.identity.from;

    // The reserve list for this cycle, revalidated against the chain — the one source for both
    // questions asked below: what the signer must hold and approve (the borrowable tokens), and
    // which token each repay amount belongs to (`spendFor`, by reserve id). Held for the cycle so
    // every candidate is judged against the same topology the balances were published for.
    this.topology = await this.deps.reserves();
    const tokens = await this.approvedTokens();

    // Before the balances, because an allowance the adapter cannot pull makes them meaningless —
    // and because this is the first point in the cycle that is downstream of the gate's HALTED
    // check, so it is the earliest place an approval may legitimately be sent.
    await this.approveAdapter(tokens);

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
    return { spend: this.spendFor(candidate) };
  }

  /**
   * What this candidate's call can pull from the signer, per token.
   *
   * `candidate.amounts` is indexed by **reserve id** over every reserve the Spoke lists — the Lens
   * sizes it from `getReserveCount()` and the adapter pulls `amounts[i]` in reserve `i`'s
   * underlying. So the token behind an amount comes from the reserve at that id and from nowhere
   * else. Deriving it from the borrowable subset (which skips reserve ids) charges one token's
   * outflow to another's balance the moment any non-borrowable reserve sorts before a borrowable
   * one, and the gate then admits liquidations the signer cannot fund while blocking ones it can.
   *
   * Everything that could make the mapping a guess throws instead. A wrong entry here is not a bad
   * estimate — it is the shared signer's overdraw guard pointed at the wrong balance, and since a
   * settled outflow becomes a hold the gate keeps until the chain settles it, a wrong one now
   * outlives the cycle that made it.
   */
  private spendFor(candidate: LiquidationCandidate): TokenSpend[] {
    const { wbtcAddress, executor } = this.deps;
    const reserves = this.topology?.reserves;
    if (!reserves) {
      throw new Error(
        "inventory funding vetted a candidate before refreshInventory read the Spoke"
      );
    }
    if (candidate.amounts.length !== reserves.length) {
      // Not truncated or padded to fit: a length that disagrees means this array is keyed by a
      // reserve list we do not have, so every index in it is a guess. The adapter itself only
      // requires `amounts.length <= reserveCount`, so a short array would execute happily while
      // silently omitting the reserves past its end.
      throw new Error(
        `Lens returned ${candidate.amounts.length} reserve amount(s) for ${candidate.position.proxyAddress} but the Spoke lists ${reserves.length} reserve(s) — refusing to attribute the spend`
      );
    }

    // Inventory funding spends the signer's own tokens, so it is both the payer and the account
    // the gate reserves against.
    const owner = executor.identity.from;
    // Summed per token: two reserves can share an underlying, and the WBTC payment below lands on
    // the same balance as a WBTC repayment. One entry per token is what the signer actually owes.
    const byToken = new Map<string, TokenSpend>();
    const add = (token: Address, amount: bigint) => {
      // Zero is the normal case for most reserves — the borrower owes them nothing — and the
      // adapter skips those inputs entirely. Declaring one would be worse than noise: the gate
      // checks that it knows a balance *before* it looks at the amount, so a zero entry for a
      // collateral-only reserve blocks every liquidation this bot could otherwise fund.
      if (amount === 0n) return;
      const k = token.toLowerCase();
      const existing = byToken.get(k);
      if (existing) existing.amount += amount;
      else byToken.set(k, { owner, token, amount });
    };

    // Every reserve, borrowable or not. `borrowable` restricts *borrowing*; the adapter repays
    // existing debt with a plain `transferFrom` and takes vaultBTC collateral, so debt left on a
    // frozen reserve is still liquidatable by anyone holding its token — and where that token is
    // one we already hold (another reserve lists it, or it is WBTC) this liquidation simply works.
    // Where we do not hold it, the gate has no balance for it and blocks the action by itself.
    for (const [id, amount] of candidate.amounts.entries()) add(reserves[id].token, amount);

    // The adapter's fairness payment (plus the redemption fee in direct mode) is a separate pull
    // in the adapter's own WBTC, on top of whatever the WBTC reserve is repaid.
    add(wbtcAddress, candidate.wbtcPayment);
    return [...byToken.values()];
  }
}
