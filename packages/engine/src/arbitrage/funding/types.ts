import type { ContractCall } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { RiskGate, TokenSpend } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";
import type { AllowanceResult, Executor } from "../../shared/executor";
import type { ArbitrageMetrics } from "../engine";

/**
 * Where the WBTC for an acquisition comes from, and therefore what the engine must do to spend it.
 *
 * The engine decides *whether* to acquire a vault — it reads the preview, prices the ceiling, and
 * asks the risk gate. This decides *how the payment happens*, which is the part that differs by
 * deployment: the signer's own balance, or a treasury's.
 */
/** The `previewEscrowedVaults` entry an acquisition is priced from. */
export interface EscrowedVaultPreview {
  amountVault: bigint;
  amountWbtcToAcquire: bigint;
  amountProfitEst: bigint;
}

export interface ArbitrageFunding {
  readonly mode: "inventory" | "router";

  /**
   * The outflow one acquisition authorizes, as the risk gate wants it.
   *
   * The mode owns the whole ledger key, not just the account: the gate reserves against
   * `(owner, token)`, and the same mode publishes the balance for that pair in `refreshInventory`.
   * Splitting it — an owner here, a token at the call site — would let the two drift apart.
   */
  spend(maxWbtcIn: bigint): TokenSpend;

  /**
   * Boot-time setup, once per process, before the first cycle.
   *
   * Where a mode verifies what it cannot fix later: a router-funded deployment reads back the
   * router's immutables and the treasury's approval, both of which are operator actions this
   * process cannot perform and whose absence otherwise surfaces only as reverted acquisitions.
   */
  prepare(): Promise<void>;

  /**
   * Publish spendable WBTC to the risk gate, once per cycle before any vault is judged.
   *
   * The gate fails closed on an account/token it has no figure for, so skipping this blocks every
   * acquisition rather than allowing an unbounded one.
   */
  refreshInventory(): Promise<void>;

  /**
   * Make sure `maxWbtcIn` can actually be delivered when the swap runs.
   *
   * Returns `satisfied` when the payment can go ahead. Anything else means an operator has to act
   * first, and the caller must free its risk slot and skip the vault.
   */
  ensureFunded(maxWbtcIn: bigint): Promise<AllowanceResult>;

  /**
   * Our transaction reverted and the vault is gone — did this mode's funds pay for it anyway?
   *
   * A reverted transaction normally proves nothing moved, which is why the caller can release the
   * reservation and call it a lost race. That only holds while our transaction is the *only* way
   * the payment could happen, so a mode where it is not has to answer this.
   *
   * The mode owns the search window: it is the only thing that knows when — and whether — an
   * authorization for this vault ever left the process.
   */
  spentWithoutUs(authorizationId: Hex | undefined): Promise<boolean>;

  /**
   * Did this acquisition's authorization expire before the transaction carrying it mined?
   *
   * A revert on a vault that is *still in escrow* normally means the chain rejected what we tried
   * to do, which is our failure and feeds the breaker. An expired authorization is not that: the
   * router refuses it before touching anything, and the cause is that the transaction sat behind a
   * stalled nonce longer than the batch was signed for. Counting those as failures would let a
   * queue stall halt a healthy bot.
   */
  authorizationExpired(authorizationId: Hex | undefined, minedAtBlock: bigint): Promise<boolean>;

  /**
   * Report what became of one authorization, once the risk slot that opened it has been settled.
   *
   * Called for **every** settlement, which is the point: while the slot is open the spend is
   * `reserved` in the gate and this mode is owed nothing. After it closes, a batch that can still
   * execute is a claim on the treasury that nothing else is counting — see
   * `RouterFunding.refreshInventory`.
   *
   * `consumed` means the money provably moved (our own acquisition confirmed), and `minedAtBlock`
   * is where — the height a balance read has to reach before it reports the payment. Until it does,
   * the outflow is still the mode's to account for, exactly as an unexecuted batch is. Anything
   * else leaves the authorization live until it expires or is observed executing.
   *
   * Idempotent, and a no-op for a mode whose payment cannot outlive its transaction.
   */
  settleAuthorization(
    authorizationId: Hex | undefined,
    outcome: { consumed: boolean; minedAtBlock?: bigint }
  ): void;

  /**
   * The call that acquires one vault, bounded by the slippage-adjusted ceiling.
   *
   * Asynchronous because a mode may have to sign before the call exists: router funding wraps the
   * acquisition in an EIP-712 batch whose signature is one of the call's own arguments.
   */
  buildAcquisition(input: {
    vaultId: Hex;
    preview: EscrowedVaultPreview;
    maxWbtcIn: bigint;
  }): Promise<AcquisitionCall>;
}

/**
 * The call to broadcast, plus the identity of any authorization building it created.
 *
 * `authorizationId` is present only for a mode that signs a payment separately from the
 * transaction. It is what the engine hands back to `spentWithoutUs`, `authorizationExpired` and
 * `settleAuthorization`, so those answer about *this* batch rather than about whatever was last
 * signed for the same vault — the batch carries no nonce, so more than one can be live at once.
 */
export interface AcquisitionCall {
  call: ContractCall;
  authorizationId?: Hex;
}

/**
 * Everything a funding mode may read. Modes narrow it with `Pick` rather than declaring their own
 * dependency lists, so a new shared dependency is one field here rather than an argument threaded
 * through the engine and every mode.
 */
export interface FundingContext {
  publicClient: PublicClient;
  risk: RiskGate;
  /** Matches the liquidation funding context: a mode's own anomalies need somewhere to surface. */
  logger: Logger;
  /** Where a mode publishes what it can actually spend — see `recordFundingCapacity`. */
  metrics: Pick<ArbitrageMetrics, "recordFundingCapacity">;
  executor: Executor;
  wbtcAddress: Address;
  vaultSwapAddress: Address;
  /** Bounds how far the spend ceiling may exceed the preview, and how far its profit may fall. */
  maxSlippageBps: number;
  /**
   * Registered vault keeper the acquired vault is redeemed to, splitting the payer from the
   * beneficiary. Unset ⇒ the executor must itself be a registered keeper and pays for itself.
   */
  vaultKeeperAddress?: Address;
  /**
   * Which mode to build. Omitted ⇒ `inventory`, which is what a deployment that configures nothing
   * gets. Carried here rather than passed alongside so the choice and the collaborators it needs
   * cannot disagree — a separate argument could name one mode while this field named another.
   */
  funding?: FundingParams;
}

/** What a composition root supplies to pick a mode. */
export type FundingParams = { mode: "inventory" } | RouterFundingParams;

export interface RouterFundingParams {
  mode: "router";
  routerAddress: Address;
  /** How long a signed batch stays valid, in chain seconds. */
  deadlineSeconds: number;
}
