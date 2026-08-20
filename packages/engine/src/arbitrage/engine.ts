import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  formatUnits,
} from "viem";

import { vaultSwapAbi } from "@repo/abis";
import { waitForReceiptWithTimeout } from "@repo/execution";
import type { ActionOutcome } from "@repo/risk";
import type { RiskSlot } from "@repo/risk";
import { BaseEngine, type BaseEngineConfig } from "../shared/engine";
import { maxWbtcInWithSlippage } from "./domain";
import { type ArbitrageFunding, type FundingParams, createArbitrageFunding } from "./funding";
import type { EscrowedVault, PonderResponse } from "./types";

/**
 * Outcome of one `acquireVault`. `send-error` (the broadcast threw — ambiguous) tells `run()`
 * to stop the cycle, since the failed nonce may leave a gap; `skipped` (not found / unprofitable
 * / risk-blocked / gas-fail / duplicate / revert / timeout) lets the loop continue.
 */
export type AcquireOutcome = "acquired" | "skipped" | "send-error";

/**
 * One acquisition that reached the chain, carrying everything the receipt phase needs to settle it:
 * the risk slot it reserved, the intent to record against, and the WBTC it committed.
 */
interface SentAcquisition {
  hash: Hex;
  intentId?: string;
  slot: RiskSlot;
  vaultId: string;
  /** Fresh on-chain acquisition cost (`amountWbtcToAcquire`), not the indexer's figure. */
  currentDebt: bigint;
  maxWbtcIn: bigint;
  /** Identity of the authorization this acquisition was built under, if the mode signs one. */
  authorizationId?: Hex;
}

/** Result of preparing + broadcasting one acquisition, before any receipt is awaited. */
type PrepareResult =
  | { kind: "sent"; entry: SentAcquisition }
  | { kind: "skipped" }
  | { kind: "send-error" };

/** Observability port — the engine reports through it; the service supplies metrics. */
export interface ArbitrageMetrics {
  recordError(type: string): void;
  recordPollDuration(durationMs: number): void;
  recordVaultAcquired(debt: bigint): void;
  recordWbtcBalance(balance: bigint): void;
  /**
   * Spendable WBTC for acquisitions, and what bounds it.
   *
   * Reported by the funding mode rather than derived from `recordWbtcBalance`, because under
   * treasury funding the signer's balance is the wrong account entirely — and capacity there is
   * the *lesser* of the treasury's balance and its allowance to the router, either of which can
   * run out first. An operator watching only a balance would miss an exhausted approval.
   */
  recordFundingCapacity(capacity: {
    owner: string;
    balance: bigint;
    allowance?: bigint;
    /**
     * WBTC held back for signed batches that are settled but still executable — the gap between
     * what the treasury holds and what the bot may commit. Router funding only.
     */
    authorized?: bigint;
  }): void;
}

/**
 * Domain parameters the arbitrage pipeline operates on — the env-derivable
 * subset shared by the engine config and the service's own config (no runtime
 * deps like clients or metrics). Services extend this so the fields are declared
 * once, here, next to the engine that consumes them.
 */
export interface ArbitrageEngineParams {
  vaultSwapAddress: Address;
  wbtcAddress: Address;
  maxSlippageBps: number;
  vaultProcessingDelayMs: number;
  txReceiptTimeoutMs: number;
  /**
   * Registered vault keeper the acquired vault is redeemed to, splitting the payer from the
   * beneficiary: this process pays the WBTC, that keeper's BTC key receives the vault
   * (`swapWbtcForVaultOnBehalf`). Set it when whoever signs is **not** itself a keeper — a
   * treasury multisig, or a Safe in MANUAL custody, which can never be one because keepers are
   * registered by BTC public key against a roster frozen at vault creation.
   *
   * Unset (the default) the executor must be a registered keeper and pays for itself
   * (`swapWbtcForVault`).
   */
  vaultKeeperAddress?: Address;
  /** Where the WBTC for an acquisition comes from. Omitted ⇒ the signer's own balance. */
  funding?: FundingParams;
}

export interface ArbitrageEngineConfig
  extends ArbitrageEngineParams,
    BaseEngineConfig<ArbitrageMetrics> {}

export class ArbitrageEngine extends BaseEngine<ArbitrageMetrics> {
  private vaultSwapAddress: Address;
  private wbtcAddress: Address;
  private funding: ArbitrageFunding;
  private maxSlippageBps: number;
  private vaultProcessingDelayMs: number;
  private txReceiptTimeoutMs: number;

  constructor(config: ArbitrageEngineConfig) {
    super(config, { engine: "arbitrage", intentAction: "vault-acquisition" });
    this.vaultSwapAddress = config.vaultSwapAddress;
    this.wbtcAddress = config.wbtcAddress;
    // The config already carries every collaborator a mode needs, so it is spread in rather than
    // re-listed field by field.
    this.funding = createArbitrageFunding(config);
    this.maxSlippageBps = config.maxSlippageBps;
    this.vaultProcessingDelayMs = config.vaultProcessingDelayMs;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs;
  }

  /**
   * Boot-time setup, once per process, before the first cycle.
   *
   * One call so a service never has to know which setup its funding mode needs: the signer paying
   * for itself has nothing to verify, while a treasury-funded deployment checks the router and the
   * approval it cannot grant itself.
   */
  async prepare(): Promise<void> {
    await this.funding.prepare();
  }

  protected async poll(cycleSlots: RiskSlot[]): Promise<void> {
    // Fetch escrowed vaults from Ponder (with the freshness stamp of its reads)
    const { vaults, dataTimestampMs } = await this.fetchEscrowedVaults();

    if (vaults.length === 0) {
      this.logger.info("No escrowed vaults available");
      return;
    }

    this.logger.info(`Found ${vaults.length} escrowed vault(s)`);

    // SEND PHASE — broadcast every acquisition we can afford, awaiting no receipts. Same shape
    // as `LiquidationEngine`: send-all, then batch-wait. Awaiting each receipt inline (and
    // sleeping between vaults) made one poll cycle take as long as the whole batch serialized —
    // measured at ~5.8 s/vault, a 133 s cycle for 23 vaults — during which the engine neither
    // re-read the escrow nor reacted to anything newly escrowed.
    //
    // The exposure cap (`RISK_MAX_IN_FLIGHT`) is the concurrency bound: every send reserves a
    // slot, so the gate — not a sleep — decides how much may be in flight at once.
    //
    // Inventory. Serialization was doing real work here that batching removes: each swap settled
    // before the next gas estimate, so the estimate was itself an accurate balance check. With N
    // sends in flight, N estimates all pass against the same starting balance and the batch can
    // overdraw — and an overdrawn swap reverts with the vault still in escrow, so it is not a
    // lost race and DOES feed the breaker.
    //
    // The gate owns that accounting rather than a local counter, because the liquidation engine
    // spends the same signer's WBTC concurrently; a per-batch budget here could not see it. We
    // just publish a fresh balance and declare each acquisition's worst case as `spend`.
    await this.funding.refreshInventory();
    const sent: SentAcquisition[] = [];

    for (const vault of vaults) {
      const prep = await this.prepareAndSend(vault, dataTimestampMs);

      if (prep.kind === "sent") {
        sent.push(prep.entry);
        cycleSlots.push(prep.entry.slot);
        // Opt-in throttle between BROADCASTS — it no longer gates a full acquisition, so it costs
        // one pause per send rather than one per round trip. Defaults to 0 (off): the liquidation
        // engine sends back-to-back unthrottled and this now matches it. Raise it only for an RPC
        // that rate-limits bursts.
        if (this.vaultProcessingDelayMs > 0) await this.sleep(this.vaultProcessingDelayMs);
        continue;
      }
      if (prep.kind === "send-error") {
        // Ambiguous — the tx may have propagated, leaving a possible nonce gap. Stop sending;
        // the receipts already in `sent` are still awaited below, and the next cycle's
        // reconcile + resync resolve the gap and re-drive.
        this.logger.warn("Stopping sends after a send error; will re-drive next cycle");
        break;
      }
    }

    // RECEIPT PHASE — one batch wait for everything broadcast above.
    if (sent.length === 0) return;
    this.logger.info(`Waiting for ${sent.length} acquisition receipt(s)...`);
    const receipts = await Promise.allSettled(
      sent.map(({ hash }) =>
        waitForReceiptWithTimeout(this.publicClient, hash, this.txReceiptTimeoutMs, "swap")
      )
    );

    for (let i = 0; i < sent.length; i++) {
      const result = receipts[i];
      if (result.status === "fulfilled") {
        // Per item: classifying one acquisition must not abandon the rest. Without this a single
        // failed read leaves every later slot to the cycle backstop, which marks them `abandoned`
        // — turning one blip into N reverts the breaker never sees, and N intents never recorded.
        try {
          await this.finishAcquisition(sent[i], result.value);
        } catch (error) {
          this.metrics.recordError("classification_error");
          this.logger.error(`Failed to classify the receipt for ${sent[i].hash}: ${error}`);
        }
      } else {
        // The receipt lookup itself failed — the tx's fate is unknown, so this is not evidence
        // the chain rejected us. Leave the intent live for reconcile and free the slot without
        // blaming the breaker. `unresolved`, not `abandoned`: the tx IS out there, so its WBTC
        // stays counted as spent — held by its hash until the chain says what became of it.
        this.settle(
          sent[i].slot,
          { ok: false, unresolved: true, txHash: sent[i].hash },
          sent[i].authorizationId
        );
        this.metrics.recordError("receipt_fetch_error");
        this.logger.error(`Failed to get receipt for ${sent[i].hash}: ${result.reason}`);
      }
    }
  }

  /**
   * Fetch escrowed vaults from Ponder indexer with retry
   */
  private async fetchEscrowedVaults(): Promise<{
    vaults: EscrowedVault[];
    dataTimestampMs?: number;
  }> {
    try {
      const data = await this.indexer.read<PonderResponse>("/escrowed-vaults");
      if (!Array.isArray(data.vaults)) {
        throw new Error("Invalid Ponder response: vaults must be an array");
      }
      // A vault the indexer could not read is missing from the list rather than marked in it, so
      // this is the only thing that tells a short list from a complete one. The cycle still acts on
      // what it got — a vault nobody can preview must not stop the ones that are fine — but it says
      // so, because "no more vaults" and "no more vaults we can see" are not the same answer.
      if (data.failedVaultsCount) {
        this.metrics.recordError("vaults_unreadable");
        this.logger.warn(
          `Indexer could not read ${data.failedVaultsCount} escrowed vault(s) this cycle — the escrow list is incomplete`
        );
      }
      return { vaults: data.vaults, dataTimestampMs: data.dataTimestampMs };
    } catch (error) {
      this.logger.error("Failed to fetch escrowed vaults:", error);
      this.metrics.recordError("ponder_fetch_error");
      return { vaults: [] };
    }
  }

  /**
   * Release a slot for an acquisition this process did not broadcast — asking the funding mode
   * first whether its funds went anyway.
   *
   * "We sent nothing" normally means "our money stayed put", which is what `abandoned` encodes. It
   * stops being true once the payment is authorized *separately* from the transaction: a signed
   * batch for a permissionless relay is executable by anyone who sees it, and it is seen before we
   * broadcast — gas estimation puts it in front of an RPC provider first. Releasing the
   * reservation while such a batch is live could admit a later vault against money already spent.
   */
  private async abandonAfterAuthorizing(
    slot: RiskSlot,
    vaultId: Hex,
    authorizationId?: Hex
  ): Promise<void> {
    const verdict = await this.spendVerdict(vaultId, authorizationId);
    if ("spent" in verdict && verdict.spent) {
      this.logger.warn(`Vault ${vaultId} was acquired with our authorization by another submitter`);
      this.metrics.recordError("relay_executed_elsewhere");
    }
    this.settle(slot, { ok: false, abandoned: true, ...verdict }, authorizationId);
  }

  /**
   * Settle one acquisition's risk slot, and hand its authorization's accounting over in the same
   * breath.
   *
   * Every settlement for an acquisition goes through here, because "the slot closed" is exactly
   * when the gate stops reserving the spend — and a signed batch that can still execute has to
   * start being counted somewhere else at that moment. Scattering the hand-off through the
   * branches is how it was missed on the three paths that settle `unresolved` directly.
   *
   * `slot.settle` is idempotent and so is `settleAuthorization`, so a `finally` backstop calling
   * this after a precise path already did changes nothing.
   */
  private settle(slot: RiskSlot, outcome: ActionOutcome, authorizationId?: Hex): void {
    slot.settle(outcome);
    // Only a confirmed acquisition proves the money moved; everything else leaves the batch live
    // until it expires or is observed executing.
    this.funding.settleAuthorization(authorizationId, { consumed: outcome.ok === true });
  }

  /**
   * Whether the vault has left escrow — i.e. another arbitrageur acquired it. Used only to classify
   * a reverted swap: `isVaultAcquirable` returns a clean bool, so a genuine RPC failure throws and
   * is caught as `false` (still acquirable ⇒ treat the revert as a real failure). Failing toward
   * "not a lost race" is deliberate: a blip must never exempt a real failure from the breaker.
   */
  private async wasVaultTaken(vaultId: Hex): Promise<boolean> {
    try {
      const acquirable = await this.publicClient.readContract({
        address: this.vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "isVaultAcquirable",
        args: [vaultId],
      });
      return !acquirable;
    } catch {
      return false;
    }
  }

  /**
   * Did the funding mode's authorization expire before the tx mined?
   *
   * A read failure answers `false`, for the same reason `wasVaultTaken` does: the caller reads
   * "not expired" as "the chain refused this on its merits", which feeds the breaker. Answering
   * `true` on a failed read would exempt a genuine failure from it, and a breaker that a flaky
   * endpoint can silence is not one.
   */
  private async didAuthorizationExpire(
    vaultId: Hex,
    minedAtBlock: bigint,
    authorizationId?: Hex
  ): Promise<boolean> {
    try {
      return await this.funding.authorizationExpired(authorizationId, minedAtBlock);
    } catch (error) {
      this.logger.error(
        `Could not tell whether the authorization for ${vaultId} expired; treating the revert as a genuine failure: ${error}`
      );
      this.metrics.recordError("classification_error");
      return false;
    }
  }

  /**
   * Whether the funding mode's money paid for this vault without our transaction — as an outcome
   * fragment, because "we could not find out" is a third answer and the risk ledger needs it.
   *
   * `spendUnknown` is not a softer `spent`: both count the outflow. It exists so the flag says why,
   * rather than a failed read quietly reading as "our money stayed put" — which would release the
   * reservation and let the same balance be committed twice.
   */
  private async spendVerdict(
    vaultId: Hex,
    authorizationId?: Hex
  ): Promise<{ spent: boolean } | { spendUnknown: true }> {
    try {
      return { spent: await this.funding.spentWithoutUs(authorizationId) };
    } catch (error) {
      this.logger.error(
        `Could not tell whether our authorization for ${vaultId} paid; keeping its WBTC counted as spent: ${error}`
      );
      this.metrics.recordError("spend_check_error");
      return { spendUnknown: true };
    }
  }

  /**
   * Acquire a vault by swapping WBTC for it (redemption is atomic). Single-vault path: broadcast,
   * then await this one receipt. `run()` uses the batched `prepareAndSend` + `finishAcquisition`
   * pair instead; this remains the direct entry point for acquiring one vault.
   *
   * No WBTC budget is threaded here. With a single swap in flight the gas estimate is itself an
   * accurate balance check — nothing else of ours is spending concurrently — which is exactly the
   * property the batch path loses and has to replace with explicit accounting.
   */
  async acquireVault(vault: EscrowedVault, dataTimestampMs?: number): Promise<AcquireOutcome> {
    const prep = await this.prepareAndSend(vault, dataTimestampMs);
    if (prep.kind === "send-error") return "send-error";
    if (prep.kind !== "sent") return "skipped";

    let receipt: Awaited<ReturnType<typeof waitForReceiptWithTimeout>>;
    try {
      receipt = await waitForReceiptWithTimeout(
        this.publicClient,
        prep.entry.hash,
        this.txReceiptTimeoutMs,
        "swap"
      );
    } catch (error) {
      // `waitForReceiptWithTimeout` returns null on ITS timeout but re-throws anything else. The
      // slot belongs to us from `sent` onward, so this must not escape unsettled — that would leak
      // exposure capacity permanently. The tx's fate is unknown, so free it without blaming the
      // breaker and leave the intent live for reconcile — and keep its WBTC counted as spent,
      // held by its hash, because the tx was broadcast and may still land.
      this.settle(
        prep.entry.slot,
        { ok: false, unresolved: true, txHash: prep.entry.hash },
        prep.entry.authorizationId
      );
      this.metrics.recordError("receipt_fetch_error");
      this.logger.error(`Failed to get receipt for ${prep.entry.hash}: ${error}`);
      return "skipped";
    }
    return this.finishAcquisition(prep.entry, receipt);
  }

  /**
   * Everything up to and including the broadcast: preview, inventory, risk slot, approval, gas
   * estimate, commit. Awaits no receipt, so a caller may run it back-to-back across many vaults.
   *
   * On `sent` the risk slot is handed to the caller and MUST be settled by the receipt phase — on
   * every other outcome this method settles it before returning.
   */
  private async prepareAndSend(
    vault: EscrowedVault,
    dataTimestampMs?: number
  ): Promise<PrepareResult> {
    const { vaultId, btcAmount, currentDebt } = vault;
    const currentDebtBigInt = BigInt(currentDebt);
    const btcAmountBigInt = BigInt(btcAmount);
    // Assigned once the risk gate allows this acquisition; from then on every exit must settle it
    // (the `finally` is the backstop). Stays undefined if we bail before ever asking the gate.
    let slot: RiskSlot | undefined;
    // Set once the slot becomes the receipt phase's responsibility; until then this method owns it.
    let handedOff = false;
    // Set once a batch has been signed for this vault. Declared out here because the exits that
    // matter most for it are the catch and the `finally` below: an authorization that outlives an
    // unexpected throw still has to be handed over to the funding mode's own accounting.
    let authorizationId: Hex | undefined;

    this.logger.info("Attempting to acquire vault:");
    this.logger.info(`   Vault ID: ${vaultId}`);
    this.logger.info(`   BTC Amount: ${formatUnits(btcAmountBigInt, 8)} WBTC`);
    this.logger.info(`   Current Debt (indexer): ${formatUnits(currentDebtBigInt, 8)} WBTC`);

    try {
      const previewResults = await this.publicClient.readContract({
        address: this.vaultSwapAddress,
        abi: vaultSwapAbi,
        functionName: "previewEscrowedVaults",
        args: [[vaultId as Hex]],
      });

      if (previewResults.length === 0) {
        this.logger.warn(`Vault ${vaultId} not found in escrow, skipping`);
        this.metrics.recordError("vault_skipped");
        return { kind: "skipped" };
      }

      const preview = previewResults[0];
      if (preview.amountProfitEst === 0n) {
        this.logger.warn(`Vault ${vaultId} is currently unprofitable, skipping`);
        this.logger.warn(
          `   Debt: ${formatUnits(preview.amountDebt, 8)} WBTC | Interest: ${formatUnits(preview.amountInterest, 8)} WBTC | Fee: ${formatUnits(preview.amountFee, 8)} WBTC`
        );
        this.metrics.recordError("vault_skipped");
        return { kind: "skipped" };
      }

      // Slippage-adjusted ceiling on what we will pay. `swapWbtcForVault` charges the debt+fee
      // prevailing at execution and only reverts *above* this ceiling, so `maxWbtcIn` — not the
      // preview cost — is the amount the tx actually authorizes.
      //
      // Priced off the FRESH on-chain preview, not the indexer's `currentDebt`. Escrow debt only
      // accrues, so a lagging indexer reports it too low, which would set the ceiling below the
      // real cost (the swap then reverts — and a revert with the vault still in escrow is not a
      // lost race, so it feeds the breaker), understate what the batch budget must reserve, and
      // overstate `expectedProfit` against `RISK_MIN_PROFIT`. The read is already made above.
      const acquireCost = preview.amountWbtcToAcquire;
      const maxWbtcIn = maxWbtcInWithSlippage(acquireCost, this.maxSlippageBps);

      // Risk gate — check just before committing to the acquisition. The profit floor must bound
      // the WORST case the tx permits, not the optimistic preview: interest can accrue between
      // preview and execution and the swap still succeeds anywhere up to `maxWbtcIn`. Both legs
      // are 8-dec sats (we receive the vault's BTC, we pay WBTC), so this is already the unit
      // `minProfit` expects. May be negative — bigint comparison handles that.
      //
      // This is profit for the PRINCIPAL, not for the signing account. Under `vaultKeeperAddress`
      // the BTC lands on the keeper's key while the WBTC leaves this process's executor, so the
      // acquisition looks like a pure outflow if you score it per-account. That is intended: the
      // on-behalf split exists for one owner operating a funding account and a permissioned keeper
      // (a treasury multisig paying for its own keeper), so both legs belong to the same balance
      // sheet and netting them is the correct frame. Pointing `vaultKeeperAddress` at a keeper you
      // do NOT own would make this number — and therefore `RISK_MIN_PROFIT` — meaningless.
      const expectedProfit = preview.amountVault - maxWbtcIn;
      slot = this.risk.openSlot({
        kind: this.intentAction,
        subject: vaultId,
        expectedProfit,
        dataTimestampMs,
        // The WORST case the tx authorises, not the preview cost — the swap may legally charge
        // anywhere up to this. Reserved until the receipt phase settles, so a concurrent
        // liquidation on the same signer cannot spend the same WBTC.
        spend: [this.funding.spend(maxWbtcIn)],
      });
      if (!slot.allowed) {
        this.logger.warn(`Risk gate blocked vault ${vaultId}: ${slot.reason}`);
        this.metrics.recordError("risk_blocked");
        return { kind: "skipped" };
      }

      // Make sure the slippage-adjusted max spend can actually be delivered. Under inventory
      // funding that is the signer's approval to the LLP: AUTO broadcasts + waits (only ever
      // returns `satisfied`); MANUAL proposes it for the operator to sign and returns
      // `proposed`/`duplicate` — the swap cannot go out until they do, so free the slot and skip
      // this vault (the intent stands; a later cycle retries the swap).
      const approval = await this.funding.ensureFunded(maxWbtcIn);
      if (approval.kind !== "satisfied") {
        this.logger.info(`WBTC funding ${approval.kind} — awaiting operator signature`);
        slot.settle({ ok: false, abandoned: true });
        return { kind: "skipped" };
      }

      this.logger.info(
        `Max WBTC willing to pay: ${formatUnits(maxWbtcIn, 8)} (${this.maxSlippageBps / 100}% slippage)`
      );

      // ONE call description, used for both the estimate below and the commit further down — an
      // estimate of a different call would validate something we never broadcast.
      const built = await this.funding.buildAcquisition({
        vaultId: vaultId as Hex,
        preview,
        maxWbtcIn,
      });
      const call = built.call;
      authorizationId = built.authorizationId;

      // From here on an authorization for this vault exists and may outlive this transaction, so
      // every exit below settles through `abandonAfterAuthorizing` rather than releasing outright.
      // Estimate gas first to catch potential failures early
      try {
        await this.publicClient.estimateContractGas({
          ...call,
          account: this.identity.from,
        } as Parameters<typeof this.publicClient.estimateContractGas>[0]);
      } catch (gasError) {
        const errorMsg = gasError instanceof Error ? gasError.message : String(gasError);
        // Same classification the post-broadcast path applies: an estimate reverts with
        // `VaultNotAcquirable` whenever the vault left escrow between the indexer read and now,
        // which is ordinary competition, not a fault. Reported as `gas_estimation_failed` it
        // inflates the error metric with routine races and buries genuine estimate failures.
        const lostRace = await this.wasVaultTaken(vaultId as Hex);
        if (lostRace) {
          this.logger.info(`Vault ${vaultId} taken before acquisition — skipping, not a failure`);
          this.metrics.recordError("race_lost");
        } else {
          this.logger.error(`Gas estimation failed for vault ${vaultId}, skipping`);
          this.logger.error(`   Error: ${errorMsg}`);
          this.metrics.recordError("gas_estimation_failed");
        }
        // Nothing broadcast by us — free the exposure slot without blaming the chain.
        await this.abandonAfterAuthorizing(slot, vaultId as Hex, authorizationId);
        return { kind: "skipped" };
      }

      // Commit the swap through the mode seam. AUTO signs + broadcasts under the shared nonce lock
      // (claim → send → markPending → submitted, all inside `commit`); MANUAL proposes + notifies.
      const out = await this.executor.commit(call, {
        // What the transaction actually calls — the LLP under inventory funding, the router under
        // router funding. Naming a fixed address instead would put one contract in the persisted
        // intent and the idempotency key while the signed payload went to another, which is what an
        // operator reads when deciding whether to sign a MANUAL proposal.
        target: call.address,
        action: this.intentAction,
        subject: vaultId,
      });

      if (out.kind !== "broadcast") {
        switch (out.kind) {
          case "duplicate":
            // A live intent for this subject already exists — nothing broadcast; free the slot.
            await this.abandonAfterAuthorizing(slot, vaultId as Hex, authorizationId);
            this.metrics.recordError("intent_in_flight");
            return { kind: "skipped" };
          case "proposed":
            // MANUAL — written down for an operator; nothing on chain, no receipt to await.
            await this.abandonAfterAuthorizing(slot, vaultId as Hex, authorizationId);
            return { kind: "skipped" };
          case "aborted":
            this.logger.error(`Failed to send swap for vault ${vaultId}: ${out.error}`);
            this.metrics.recordError("swap_send_error");
            // Only a failed *broadcast* is a real failure signal for the breaker; a pre-broadcast
            // failure reached no chain, so an RPC/database blip cannot trip it.
            if (out.broadcastAttempted) this.settle(slot, { ok: false }, authorizationId);
            else await this.abandonAfterAuthorizing(slot, vaultId as Hex, authorizationId);
            // The send left a possible nonce gap — stop the cycle; the next resync reclaims it.
            return { kind: "send-error" };
          default:
            return out satisfies never; // exhaustiveness — a new `CommitResult` kind must be handled
        }
      }

      // Broadcast (or ambiguously so). The intent is already `submitted` (recorded inside `commit`).
      const { hash, intentId } = out;
      this.logger.info(`Swap transaction sent: ${hash}`);
      handedOff = true;
      return {
        kind: "sent",
        entry: {
          hash,
          intentId,
          slot,
          vaultId,
          currentDebt: acquireCost,
          maxWbtcIn,
          // Carried to the receipt phase so its settlement can hand this batch's accounting over.
          // Without it every classification tells the funding mode about `undefined`, and a live
          // authorization is held by nothing.
          authorizationId,
        },
      };
    } catch (error) {
      // Only counts against the breaker if the gate had already allowed this acquisition. A
      // throw from the preview read or the Ponder fetch is an infrastructure error, not a failed
      // action — and it holds no exposure slot to release. (Those surface via `metrics`.)
      if (slot) this.settle(slot, { ok: false }, authorizationId);
      let errorMsg = "Unknown error";
      // viem wraps an on-chain revert in ContractFunctionExecutionError and hangs the
      // ContractFunctionRevertedError off its cause chain, so testing what was thrown directly
      // never matches — every revert would be miscounted as an infrastructure error and logged
      // without its name. Walk the chain instead.
      const revert =
        error instanceof BaseError
          ? error.walk((e) => e instanceof ContractFunctionRevertedError)
          : null;
      if (revert instanceof ContractFunctionRevertedError) {
        errorMsg = revert.data?.errorName || revert.shortMessage;
        this.metrics.recordError("contract_revert");
      } else if (error instanceof Error) {
        errorMsg = error.message;
        this.metrics.recordError("acquire_error");
      }

      this.logger.error(`Failed to acquire vault ${vaultId}`);
      this.logger.error(`   Error: ${errorMsg}`);
      return { kind: "skipped" };
    } finally {
      // Backstop: no path above may leave the slot reserved, EXCEPT the handed-off one the receipt
      // phase now owns. Idempotent, so real outcomes win and this only catches unsettled slots.
      if (slot && !handedOff) this.settle(slot, { ok: false, abandoned: true }, authorizationId);
    }
  }

  /**
   * Receipt half of one acquisition: classify what the chain did, settle the exposure slot it
   * reserved, and record the intent's terminal outcome.
   */
  private async finishAcquisition(
    entry: SentAcquisition,
    receipt: Awaited<ReturnType<typeof waitForReceiptWithTimeout>>
  ): Promise<AcquireOutcome> {
    const { hash, intentId, slot, vaultId, currentDebt, authorizationId } = entry;
    try {
      if (!receipt) {
        // Timing out is not evidence the chain rejected us — the tx may still be sitting in the
        // mempool, and behind a nonce gap it certainly is. Settle `abandoned` so an unknown
        // outcome cannot feed the breaker: batching puts many acquisitions in flight at once, so
        // one shared cause (a gap burned by the liquidation engine sharing this nonce allocator)
        // would otherwise land N failures simultaneously and halt a healthy bot.
        // The intent stays live (submitted) — reconcile resolves it against the chain.
        // With the hash: the gate holds this outflow by the transaction that owes it, and releases
        // it only on chain evidence — not on the next refresh, whose read this tx may still be
        // un-mined behind. (Inventory funding only; router funding accounts for its own batch.)
        this.settle(slot, { ok: false, unresolved: true, txHash: hash }, authorizationId);
        this.logger.warn(`Transaction receipt timeout for vault ${vaultId}`);
        this.metrics.recordError("tx_timeout");
        return "skipped";
      }

      if (receipt.status === "success") {
        // The height it mined at travels too, so the hold is retired by the first balance read that
        // can actually report it rather than by the next one to arrive.
        this.settle(
          slot,
          { ok: true, txHash: hash, minedAtBlock: receipt.blockNumber },
          authorizationId
        );
        this.logger.info(`Vault acquired and redeemed in block ${receipt.blockNumber}`);
        this.metrics.recordVaultAcquired(currentDebt);
        if (intentId)
          await this.executor.recordOutcome(intentId, { kind: "confirmed", txHash: hash });
        return "acquired";
      }
      // A reverted swap is only *our* failure if the vault is still there to take. If it has left
      // escrow, another arbitrageur got there first — a lost race, normal competition, which must
      // not feed the breaker (settle `contended`, not `ok:false`).
      const lostRace = await this.wasVaultTaken(vaultId as Hex);
      // What the chain did, in the words the intent is stored under. Kept as one value so the
      // persisted reason cannot drift from the branch that settled the slot — an expired
      // authorization recorded as a plain "reverted" reads, months later, as the chain refusing us.
      let classification: string;
      if (lostRace) {
        // Losing the race does not always mean keeping the money. Ask the funding mode whether its
        // funds paid for the vault anyway — they can, where the payment is authorized separately
        // from this transaction and anyone may submit that authorization. Releasing the
        // reservation in that case would hand the same balance out twice in one cycle.
        const verdict = await this.spendVerdict(vaultId as Hex, authorizationId);
        this.settle(
          slot,
          {
            ok: false,
            contended: true,
            txHash: hash,
            minedAtBlock: receipt.blockNumber,
            ...verdict,
          },
          authorizationId
        );
        if ("spendUnknown" in verdict) {
          classification = "lost race (spend unknown)";
        } else if (verdict.spent) {
          this.logger.warn(
            `Vault ${vaultId} was acquired with our own authorization by another submitter — funds spent, gas theirs`
          );
          this.metrics.recordError("relay_executed_elsewhere");
          classification = "lost race (our authorization paid)";
        } else {
          this.logger.info(`Vault ${vaultId} acquired by another bot — not counted as a failure`);
          this.metrics.recordError("race_lost");
          classification = "lost race";
        }
      } else if (
        await this.didAuthorizationExpire(vaultId as Hex, receipt.blockNumber, authorizationId)
      ) {
        // The vault is still in escrow and we did not lose a race — but the router rejected the
        // batch before touching anything, because it sat behind a stalled nonce for longer than it
        // was signed for. Nothing moved and nothing was refused on its merits, so this must not
        // feed the breaker: a queue stall would otherwise halt a perfectly healthy bot.
        this.settle(slot, { ok: false, abandoned: true }, authorizationId);
        this.logger.warn(`Authorization for vault ${vaultId} expired before its tx mined`);
        this.metrics.recordError("authorization_expired");
        classification = "authorization expired";
      } else {
        this.settle(slot, { ok: false }, authorizationId);
        this.logger.error("Swap transaction reverted");
        this.metrics.recordError("swap_reverted");
        classification = "reverted";
      }
      if (intentId)
        await this.executor.recordOutcome(intentId, {
          kind: "failed",
          txHash: hash,
          error: classification,
        });
      return "skipped";
    } finally {
      // Backstop for a throw no branch above accounted for. Settled as a genuine failure with its
      // spend still counted, rather than the cycle backstop's `abandoned`: by this point
      // the receipt is in hand, so "something went wrong while classifying a revert" must not be
      // the one outcome that exempts it from the breaker. `settle` is idempotent, so every branch
      // above still wins.
      this.settle(slot, { ok: false, spendUnknown: true }, authorizationId);
    }
  }

  /**
   * Log arbitrageur's WBTC balance
   */
  async logBalance(): Promise<void> {
    try {
      // Run metadata + balanceOf in parallel: cold-start is no slower than
      // before (still 3 concurrent reads); steady-state is just balanceOf.
      const [{ symbol, decimals }, balance] = await Promise.all([
        this.tokenMeta(this.wbtcAddress),
        this.readOwnBalance(this.wbtcAddress),
      ]);

      const formattedBalance = formatUnits(balance, decimals);
      this.logger.info(`Arbitrageur balance: ${formattedBalance} ${symbol}`);
      this.metrics.recordWbtcBalance(balance);
    } catch (error) {
      this.logger.error("Failed to fetch balance:", error);
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
