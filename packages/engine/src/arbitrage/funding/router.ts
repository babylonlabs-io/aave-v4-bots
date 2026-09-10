import {
  RELAYER_MESSAGE_TYPES,
  arbitrageRouterAbi,
  arbitrageRouterDomain,
  vaultSwapAbi,
} from "@repo/abis";
import { readAllowance, readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import type { TokenSpend } from "@repo/risk";
import { type Address, type Hex, encodeFunctionData, hashTypedData } from "viem";
import type { AllowanceResult, AutoExecutor } from "../../shared/executor";
import type {
  AcquisitionCall,
  ArbitrageFunding,
  EscrowedVaultPreview,
  FundingContext,
  RouterFundingParams,
} from "./types";

/** The router's acquisition event, extracted once so `getLogs` can be given a typed filter. */
const SWAP_EVENT = arbitrageRouterAbi.find(
  (entry) => entry.type === "event" && entry.name === "SwapWbtcToVault"
) as Extract<(typeof arbitrageRouterAbi)[number], { type: "event" }>;

export type RouterFundingDeps = Pick<
  FundingContext,
  | "publicClient"
  | "risk"
  | "metrics"
  | "logger"
  | "executor"
  | "wbtcAddress"
  | "vaultSwapAddress"
  | "vaultKeeperAddress"
  | "maxSlippageBps"
> &
  Omit<RouterFundingParams, "mode"> & {
    /**
     * The AUTO arm specifically. Router funding cannot work without a key: `executor.account`
     * signs the authorization the router checks, and it is the same account that signs the
     * transaction carrying it — so a KMS deployment authorizes through the same HSM key, at the
     * cost of a second round trip per acquisition.
     */
    executor: AutoExecutor;
    /** Required here, unlike the context's: the router only calls the on-behalf swap. */
    vaultKeeperAddress: Address;
  };

/**
 * How far a block's timestamp may lead this host's clock before signing is refused.
 *
 * The deadline is chain time (`block.timestamp` plus `deadlineSeconds`), so one RPC answer sets
 * how long a treasury-spending signature lives, and `SelfCallRelayer` has no nonce to bound
 * replay. Any lead accepted here extends that lifetime. Chain time tracks real time within
 * seconds, so a minute allows honest skew and caps what a hostile endpoint can add.
 *
 * Exceeding it throws, so the fault stays visible: a shortened batch would expire in flight,
 * which reads as not our failure.
 */
const MAX_CHAIN_TIME_LEAD_SECONDS = 60n;

/**
 * How long past its deadline an authorization is still held. Expiry is read from one block
 * header, which a shallow reorg or a lagging pool member can contradict. Releasing too early lets
 * the same treasury WBTC be committed twice. Two block times covers both cases.
 */
const AUTHORIZATION_EXPIRY_MARGIN_SECONDS = 24n;

/**
 * How far below the recorded authorization height `spentWithoutUs` starts looking.
 *
 * The height comes from the block observed at signing, and two ordinary things put the execution
 * *below* it: a reorg can replace that block, and behind a load-balanced RPC pool the endpoint
 * answering `getLogs` may sit behind the one that answered `getBlock` (the same inconsistency
 * `UNKNOWN_TX_GRACE_MS` exists for). Starting exactly at the recorded height then misses the event
 * and reports money that left as never spent — which releases its reservation and lets the same
 * balance be committed twice.
 *
 * Kept small because it is not free in the other direction: the router's event carries no
 * authorization identity, so a wider window can match an *older* acquisition of the same vault, to
 * the same keeper, through the same LLP, and report a spend this attempt never made. That error is
 * the conservative one — it over-counts an outflow, which only skips affordable work — but it is
 * still an error, so the margin covers reorg depth and replica lag and nothing more.
 */
const SCAN_REORG_MARGIN_BLOCKS = 12n;

/**
 * A treasury supplies the WBTC; this process only authorizes and submits.
 *
 * The router pulls exactly the preview cost from its immutable `payer` and sweeps any residue back,
 * so the key this bot holds can direct the treasury's allowance but never receive it. That is a
 * smaller blast radius than holding the float, not an absent one: `vaultSwap` is an argument to the
 * signed call, so a compromised authorizer can point the router at a contract of its choosing and
 * burn the whole allowance. The treasury's approval is the bound, which is why it should be working
 * capital rather than unlimited.
 */
export class RouterFunding implements ArbitrageFunding {
  readonly mode = "router" as const;

  /** The router's immutable `payer`, read in `prepare()`. */
  private payer?: Address;

  /**
   * Every signed batch this process has created and not yet retired, keyed by EIP-712 digest. The
   * relay has no nonce, so one vault can have several live batches.
   *
   * - `block`: anchor for the execution search. `spentWithoutUs` reads from below it.
   * - `deadline`: the router's own expiry. It tells a timed-out batch from a rejected one.
   * - `backed`: true while the gate still reserves `maxWbtcIn`. After settlement this map holds
   *   the claim, so it is never counted twice.
   * - `executedAt`: the block our acquisition mined in. Balance reads below it still include the
   *   WBTC, so the record stays until a read at or above it.
   */
  private authorizations = new Map<
    Hex,
    {
      vaultId: Hex;
      block: bigint;
      deadline: bigint;
      maxWbtcIn: bigint;
      backed: boolean;
      executedAt?: bigint;
    }
  >();

  /**
   * The treasury's last read balance and allowance, and the block of that read. Settlements
   * republish capacity from it between refreshes. The block lets a fresher refresh win in
   * `setAvailable`, which orders writes by height.
   */
  private inventory?: { balance: bigint; allowance: bigint; block: bigint };

  /** Live batches for one vault, oldest first — more than one can exist (see `authorizations`). */
  private forVault(vaultId: Hex) {
    return [...this.authorizations.values()].filter((a) => a.vaultId === vaultId);
  }

  constructor(private deps: RouterFundingDeps) {}

  spend(maxWbtcIn: bigint): TokenSpend {
    return {
      owner: this.payerOrThrow(),
      token: this.deps.wbtcAddress,
      amount: maxWbtcIn,
      // This mode keeps its own account of the money once the slot closes: `settleAuthorization`
      // hands the batch over to `authorizations`, and `refreshInventory` publishes a balance
      // already net of it. A gate hold on top would subtract the same WBTC twice — and would
      // release on the wrong evidence besides, since a signed batch outlives the transaction that
      // carried it and stays executable until it expires.
      accounting: "caller",
    };
  }

  /** The router's `payer`, or a clear error if `prepare()` has not read it yet. */
  private payerOrThrow(): Address {
    if (!this.payer) {
      throw new Error("router funding used before prepare(): the payer is read from the router");
    }
    return this.payer;
  }

  /**
   * Verify the deployment before the first cycle, and cache what the router says.
   *
   * Every check here is for a mistake that is otherwise invisible: a router pointed at a different
   * payer, WBTC or signer reverts every acquisition on-chain with nothing naming the cause, and a
   * missing approval does the same. These are deployment errors, not market conditions, so finding
   * them one reverted acquisition at a time costs gas and feeds the failure breaker.
   */
  async prepare(): Promise<void> {
    const { publicClient, routerAddress, wbtcAddress, executor } = this.deps;
    const read = <T>(functionName: "signer" | "payer" | "wbtc") =>
      publicClient.readContract({
        address: routerAddress,
        abi: arbitrageRouterAbi,
        functionName,
      }) as Promise<T>;

    const [signer, payer, wbtc] = await Promise.all([
      read<Address>("signer"),
      read<Address>("payer"),
      read<Address>("wbtc"),
    ]);

    const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
    // Against `account.address`, not `identity.from`: the account is what signs the authorization
    // the router checks, and an executor built over a custom sender could carry a different tx
    // identity. Comparing the wrong one would pass here and fail every acquisition on-chain.
    if (!same(signer, executor.account.address)) {
      throw new Error(
        `ArbitrageRouter ${routerAddress} authorizes ${signer}, but this bot signs as ${executor.account.address}. The signer is immutable, so this needs the right key or a different router.`
      );
    }
    // The treasury must not be the signer. Two reasons, and either alone is enough:
    //
    // Accounting — `refreshInventory` publishes this account's capacity *minus* what signed batches
    // are holding, and `RiskGate.setAvailable` is last-writer-wins. A liquidation engine in the
    // same process publishes the signer's raw WBTC balance for the same token, so if the two
    // addresses coincide it would erase the subtraction and hand the held WBTC out again.
    //
    // Design — router funding exists to keep the float away from the hot key. If they are the same
    // address the mode buys nothing that inventory funding does not, at the cost of a signature.
    if (same(payer, executor.identity.from) || same(payer, executor.account.address)) {
      throw new Error(
        `ArbitrageRouter ${routerAddress} pays from ${payer}, which is this bot's own signer. Router funding exists to separate the treasury from the signing key; with one address it also cannot account for signed batches separately from the signer's balance. Use a treasury the bot does not sign for, or ARBITRAGE_FUNDING=inventory.`
      );
    }
    // The router accepts only its signer as submitter, so the sending and authorizing accounts
    // must match. An executor over a custom sender can differ; every acquisition would revert.
    if (!same(executor.identity.from, executor.account.address)) {
      throw new Error(
        `router funding sends from ${executor.identity.from} but authorizes as ${executor.account.address}. ArbitrageRouter ${routerAddress} only relays batches submitted by its signer, so these must be one account.`
      );
    }

    if (!same(wbtc, wbtcAddress)) {
      throw new Error(
        `ArbitrageRouter ${routerAddress} pays in ${wbtc}, but WBTC_ADDRESS is ${wbtcAddress}.`
      );
    }

    // The router's WBTC is immutable, but the `vaultSwap` it pays is an argument to each call — so
    // the two can disagree, and the LLP would reject every acquisition. Checked here because the
    // router is what the treasury approved, and it can only ever deliver its own token.
    const llpWbtc = (await publicClient.readContract({
      address: this.deps.vaultSwapAddress,
      abi: vaultSwapAbi,
      functionName: "WBTC",
    })) as Address;
    if (!same(llpWbtc, wbtc)) {
      throw new Error(
        `VaultSwap ${this.deps.vaultSwapAddress} settles in ${llpWbtc}, but ArbitrageRouter ${routerAddress} pays in ${wbtc}.`
      );
    }

    const [balance, allowance] = await Promise.all([
      readBalance(publicClient, wbtcAddress, payer),
      readAllowance(publicClient, wbtcAddress, payer, routerAddress),
    ]);
    if (allowance === 0n) {
      throw new Error(
        `payer ${payer} has not approved ArbitrageRouter ${routerAddress} to spend its WBTC. Only the payer can grant this; the bot cannot approve on its behalf.`
      );
    }
    // An empty treasury is a normal state that a transfer fixes, so this only warns.
    // `refreshInventory` publishes the zero, and the gate admits nothing.
    if (balance === 0n) {
      this.deps.logger.warn(
        `payer ${payer} holds no WBTC — no acquisition can be funded until the treasury is topped up`
      );
    }

    this.payer = payer;
  }

  /**
   * Publish what the treasury can actually spend — the lesser of its balance and its approval.
   *
   * The allowance binds as hard as the balance and the bot cannot raise it, so treating the balance
   * alone as capacity would admit acquisitions that revert on the transfer.
   */
  async refreshInventory(): Promise<void> {
    const { publicClient, risk, metrics, wbtcAddress, routerAddress } = this.deps;
    const payer = this.payerOrThrow();

    // One block for everything below. A balance from one height and a log from another describe
    // two different chains: read the execution but not the payment it made, and this would retire
    // the hold *and* publish the balance that still contains the money — counting it spendable
    // twice, which is the exact error the holds exist to prevent.
    const block = await publicClient.getBlock();
    const [balance, allowance] = await Promise.all([
      readBalance(publicClient, wbtcAddress, payer, block.number),
      readAllowance(publicClient, wbtcAddress, payer, routerAddress, block.number),
    ]);
    await this.retireAuthorizations(block.number, block.timestamp);

    this.inventory = { balance, allowance, block: block.number };
    this.publishCapacity();
  }

  /**
   * Publish to the gate the treasury capacity minus every settled, unexpired batch: WBTC the gate
   * no longer reserves but a signed batch can still take.
   *
   * Runs after each refresh, and after each settlement with the last read, so the gate sees a new
   * hold before the send loop judges the next vault. Does nothing before the first refresh.
   */
  private publishCapacity(): void {
    const { risk, metrics, wbtcAddress } = this.deps;
    if (this.inventory === undefined) return;
    const { balance, allowance, block } = this.inventory;
    const payer = this.payerOrThrow();

    // Per vault, not per batch. A vault leaves escrow the first time one of these executes, so the
    // rest become inert — however many are live, together they can take at most one acquisition's
    // worth. Summing them instead would let a vault that keeps being re-signed (a duplicate intent
    // re-signs every cycle under a fresh deadline, so a fresh digest) stack holds against itself
    // until they expired, and starve the treasury for a vault nobody can buy twice.
    const worst = new Map<Hex, bigint>();
    for (const a of this.authorizations.values()) {
      if (a.backed) continue;
      const current = worst.get(a.vaultId) ?? 0n;
      if (a.maxWbtcIn > current) worst.set(a.vaultId, a.maxWbtcIn);
    }
    const held = [...worst.values()].reduce((sum, amount) => sum + amount, 0n);
    const capacity = balance < allowance ? balance : allowance;
    risk.setAvailable(
      { owner: payer, token: wbtcAddress },
      capacity > held ? capacity - held : 0n,
      block
    );
    // Both legs, not the minimum the gate gets: an operator needs to see which one is about to
    // bind, and only one of them can be topped up without a new approval. `authorized` is the third
    // subtrahend, and without it a capacity below both legs has no visible cause.
    metrics.recordFundingCapacity({ owner: payer, balance, allowance, authorized: held });
  }

  /**
   * Drop the authorizations that can no longer take anything, as of one block.
   *
   * Two ways out. **Expired**: past its deadline the router refuses the batch, so it is inert.
   * **Executed**: the money already moved, so the balance read at this same block reports it and
   * holding it as well would subtract it twice — which is why the caller pins both to one height.
   *
   * Execution is proved by the router's event in the window below or, for our own confirmed
   * acquisition, by `executedAt` at or below `head`.
   *
   * One `getLogs` for every live vault rather than one per authorization: the filter is an OR over
   * the indexed `vaultId`, and the window is short because nothing outlives its deadline.
   */
  private async retireAuthorizations(head: bigint, chainTime: bigint): Promise<void> {
    const { publicClient, routerAddress, vaultSwapAddress, vaultKeeperAddress } = this.deps;
    for (const [id, a] of this.authorizations) {
      // Our acquisition mined at or below this read, so the balance already excludes its WBTC.
      if (a.executedAt !== undefined && a.executedAt <= head) {
        this.authorizations.delete(id);
        continue;
      }
      // Expired, with margin. See `AUTHORIZATION_EXPIRY_MARGIN_SECONDS`.
      if (a.deadline + AUTHORIZATION_EXPIRY_MARGIN_SECONDS < chainTime) {
        this.authorizations.delete(id);
      }
    }
    const live = [...this.authorizations.values()];
    if (live.length === 0) return;

    const earliest = live.reduce((low, a) => (a.block < low ? a.block : low), live[0].block);
    const anchor = earliest > head ? head : earliest;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event: SWAP_EVENT,
      args: {
        vaultSwap: vaultSwapAddress,
        vaultId: [...new Set(live.map((a) => a.vaultId))],
        onBehalfOf: vaultKeeperAddress,
      },
      fromBlock: anchor > SCAN_REORG_MARGIN_BLOCKS ? anchor - SCAN_REORG_MARGIN_BLOCKS : 0n,
      toBlock: head,
    });

    // A vault leaves escrow when it is acquired, so one execution retires every batch for it: none
    // of the others can succeed afterwards.
    // A log whose `vaultId` did not decode retires nothing. The filter above already restricts the
    // query to our live vaults, so an undecodable entry means we cannot say *which* one was taken —
    // and keeping the hold is the safe half of that guess.
    const acquired = new Set(
      logs.map((log) => (log as { args?: { vaultId?: Hex } }).args?.vaultId).filter(Boolean)
    );
    for (const [id, a] of this.authorizations) {
      if (acquired.has(a.vaultId)) this.authorizations.delete(id);
    }
  }

  /**
   * Always satisfied: there is no allowance for this process to grant.
   *
   * The treasury's approval is verified once at boot and its remaining capacity is republished
   * every cycle, so affordability is the risk gate's answer here rather than a per-vault call.
   */
  async ensureFunded(): Promise<AllowanceResult> {
    return { kind: "satisfied" };
  }

  /**
   * No-op. The allowance is the treasury's, granted by an operator; this process cannot revoke it.
   */
  async revokeApprovals(): Promise<void> {}

  /**
   * Did our authorization pay for the vault in another transaction? The batch is public before we
   * broadcast (gas estimation shows it to the RPC provider), so another submission of it can
   * execute first. Our transaction then reverts like a lost race, but the treasury paid.
   *
   * The router's event decides it: it fires only on a completed acquisition, and only this signer
   * authorizes this router.
   */
  async spentWithoutUs(authorizationId: Hex | undefined): Promise<boolean> {
    const { publicClient, routerAddress, vaultSwapAddress, vaultKeeperAddress } = this.deps;
    const authorization =
      authorizationId === undefined ? undefined : this.authorizations.get(authorizationId);
    // Never authorized (or already retired), so nothing of ours can be waiting to execute.
    if (authorization === undefined) return false;
    const { vaultId } = authorization;

    // The recorded height is where the batch became executable, but it is not a safe place to start
    // reading: see `SCAN_REORG_MARGIN_BLOCKS`. A height *above* the chain we can currently see is a
    // separate anomaly — a reorg, or an endpoint that reported a block it cannot serve — and asking
    // for an inverted range is provider-dependent (some return nothing, some error), so it is
    // clamped to the head rather than left to chance.
    // The earliest live batch for this vault, not just the one asked about: any of ours paying for
    // it spent the same treasury, and they can be live together.
    const earliest = this.forVault(vaultId).reduce(
      (lowest, a) => (a.block < lowest ? a.block : lowest),
      authorization.block
    );
    const head = await publicClient.getBlockNumber();
    if (earliest > head) {
      this.deps.logger.warn(
        `Authorization for ${vaultId} was recorded at block ${earliest}, above the chain head ${head} — scanning from the head instead`
      );
    }
    const anchor = earliest > head ? head : earliest;
    const fromBlock = anchor > SCAN_REORG_MARGIN_BLOCKS ? anchor - SCAN_REORG_MARGIN_BLOCKS : 0n;

    // Filtered on all three indexed topics. `vaultId` alone would also match an acquisition of the
    // same vault through a different LLP or to a different keeper — neither of which is ours, and
    // neither of which spent our payer's WBTC.
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event: SWAP_EVENT,
      args: { vaultSwap: vaultSwapAddress, vaultId, onBehalfOf: vaultKeeperAddress },
      fromBlock,
      toBlock: "latest",
    });
    return logs.length > 0;
  }

  /**
   * Compare the deadline we signed against the chain time the transaction actually mined at.
   *
   * Chain time on both sides, because that is what the router checks — a batch is expired exactly
   * when `block.timestamp > deadline` in the block it lands in.
   */
  async authorizationExpired(
    authorizationId: Hex | undefined,
    minedAtBlock: bigint
  ): Promise<boolean> {
    // This batch's own deadline. Falling back to "the last one signed for this vault" would judge
    // the transaction that mined against a window it was never signed under.
    const authorization =
      authorizationId === undefined ? undefined : this.authorizations.get(authorizationId);
    if (authorization === undefined) return false;
    const { timestamp } = await this.deps.publicClient.getBlock({ blockNumber: minedAtBlock });
    return timestamp > authorization.deadline;
  }

  async buildAcquisition({
    vaultId,
    preview,
    maxWbtcIn,
  }: {
    vaultId: Hex;
    preview: EscrowedVaultPreview;
    maxWbtcIn: bigint;
  }): Promise<AcquisitionCall> {
    const { routerAddress, vaultSwapAddress, vaultKeeperAddress, executor, publicClient } =
      this.deps;

    const data = encodeFunctionData({
      abi: arbitrageRouterAbi,
      functionName: "swapWbtcToVault",
      args: [vaultSwapAddress, vaultId, vaultKeeperAddress, this.minProfit(preview), maxWbtcIn],
    });

    // Chain time, not wall clock: the router compares against `block.timestamp`, and a node whose
    // clock differs from ours would otherwise expire a batch early or leave it live too long.
    const block = await publicClient.getBlock();

    // Sanity-checked before it becomes a signature, because this number *is* the authorization's
    // lifetime and it arrives from a single unvalidated RPC answer. See
    // `MAX_CHAIN_TIME_LEAD_SECONDS`. Refusing here also leaves no record behind: nothing is signed
    // and nothing is added to `authorized`, so the vault is simply retried next cycle.
    const lead = block.timestamp - BigInt(Math.floor(Date.now() / 1000));
    if (lead > MAX_CHAIN_TIME_LEAD_SECONDS) {
      throw new Error(
        `refusing to sign an acquisition: block ${block.number}'s timestamp leads this host's clock by ${lead}s (limit ${MAX_CHAIN_TIME_LEAD_SECONDS}s), so the deadline it implies is not the ${this.deps.deadlineSeconds}s that was configured`
      );
    }

    const deadline = block.timestamp + BigInt(this.deps.deadlineSeconds);

    // The router accepts nothing but a signature over this exact batch, and the EIP-712 domain
    // binds it to this chain and this router — the only replay bound the scheme has, since
    // `SelfCallRelayer` carries no nonce.
    const calls = [{ data, value: 0n }] as const;
    const typedData = {
      domain: arbitrageRouterDomain({
        chainId: executor.identity.chainId,
        verifyingContract: routerAddress,
      }),
      types: RELAYER_MESSAGE_TYPES,
      primaryType: "RelayerMessage" as const,
      message: { calls, deadline },
    };
    const signature = await executor.account.signTypedData(typedData);

    // Recorded *after* signing, not before: until the signature exists there is no bearer
    // capability, and a record written ahead of one would hold treasury capacity against a batch
    // that a failed `signTypedData` never created.
    //
    // The digest is that capability's identity — the exact bytes the router recovers a signer
    // from. Two builds that hash the same are the same authorization, so collapsing them is right.
    const authorizationId = hashTypedData(typedData);
    this.authorizations.set(authorizationId, {
      vaultId,
      block: block.number,
      deadline,
      maxWbtcIn,
      // The caller still holds the risk slot that opened this acquisition, so the gate is already
      // reserving `maxWbtcIn`. `settleAuthorization` hands that duty over when the slot closes.
      backed: true,
    });

    return {
      call: {
        address: routerAddress,
        abi: arbitrageRouterAbi,
        functionName: "relay",
        args: [{ calls, deadline }, signature],
      },
      authorizationId,
    };
  }

  /** @inheritdoc */
  settleAuthorization(
    authorizationId: Hex | undefined,
    outcome: { consumed: boolean; minedAtBlock?: bigint }
  ): void {
    if (authorizationId === undefined) return;
    const authorization = this.authorizations.get(authorizationId);
    if (authorization === undefined) return; // already retired, or never ours
    // The gate no longer reserves this spend, so this map holds it, executed or not.
    authorization.backed = false;
    // For `retireAuthorizations`. Never cleared: the `finally` backstops settle again with
    // `consumed: false`.
    if (outcome.consumed && outcome.minedAtBlock !== undefined) {
      authorization.executedAt = outcome.minedAtBlock;
    }
    // Now, not at the next refresh: the send loop judges the next vault before then.
    this.publishCapacity();
  }

  /**
   * The floor the router enforces on the LLP's own estimate at execution time.
   *
   * Deliberately **not** `RISK_MIN_PROFIT`. That floor is denominated in raw BTC sats against the
   * worst-case spend (`amountVault - maxWbtcIn`), and it is already carried on-chain by `maxWbtcIn`:
   * the gate admitted this acquisition because the ceiling cleared the floor, and the router refuses
   * to pay above that ceiling. The router's own `minProfit` measures something else —
   * `max(0, amountVault * oraclePrice - amountWbtcToAcquire)`, oracle-denominated and clamped at
   * zero — so passing the operator's floor here would apply it to a quantity they never chose.
   *
   * What it does bound is drift: the estimate may fall between our read and execution as interest
   * accrues, and this allows it to fall by the same slippage the spend ceiling allows it to rise.
   */
  private minProfit(preview: EscrowedVaultPreview): bigint {
    // Clamped at 100%: the argument is a `uint256`, and a slippage above 10_000 bps would make this
    // negative and fail to encode. Past that point the floor is zero anyway — every drop allowed.
    const slippage = BigInt(Math.min(this.deps.maxSlippageBps, 10_000));
    return (preview.amountProfitEst * (10_000n - slippage)) / 10_000n;
  }
}
