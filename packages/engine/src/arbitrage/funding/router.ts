import {
  RELAYER_MESSAGE_TYPES,
  arbitrageRouterAbi,
  arbitrageRouterDomain,
  vaultSwapAbi,
} from "@repo/abis";
import { readAllowance, readBalance } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import type { TokenSpend } from "@repo/risk";
import { type Address, type Hex, encodeFunctionData } from "viem";
import type { AllowanceResult, AutoExecutor } from "../../shared/executor";
import type {
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
   * What was authorized for each vault, and when.
   *
   * `block` is the lower bound for finding an execution of the batch — derived rather than guessed,
   * since converting the deadline to blocks needs a block time we do not know, and guessing it in
   * the fast direction searches too narrow a window and reports "not spent" for money that left.
   * `deadline` is what the router itself compares against, and is how a revert caused by the batch
   * timing out is told apart from one caused by the acquisition being rejected on its merits.
   */
  private authorized = new Map<Hex, { block: bigint; deadline: bigint }>();

  constructor(private deps: RouterFundingDeps) {}

  spend(maxWbtcIn: bigint): TokenSpend {
    return { owner: this.payerOrThrow(), token: this.deps.wbtcAddress, amount: maxWbtcIn };
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
    if (balance === 0n) {
      throw new Error(`payer ${payer} holds no WBTC, so no acquisition can be funded.`);
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
    const [balance, allowance] = await Promise.all([
      readBalance(publicClient, wbtcAddress, payer),
      readAllowance(publicClient, wbtcAddress, payer, routerAddress),
    ]);
    risk.setAvailable(
      { owner: payer, token: wbtcAddress },
      balance < allowance ? balance : allowance
    );
    // Both legs, not the minimum the gate gets: an operator needs to see which one is about to
    // bind, and only one of them can be topped up without a new approval.
    metrics.recordFundingCapacity({ owner: payer, balance, allowance });
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
   * `relay` is permissionless, and the batch is visible before we broadcast anything — gas
   * estimation already put it in front of an RPC provider. A third party can submit the same
   * authorization and have it execute first, leaving our own transaction to revert on a vault that
   * is already gone. From the receipt alone that is indistinguishable from an ordinary lost race,
   * except that the treasury's WBTC *did* leave under our signature.
   *
   * The router's own event settles it: it fires only on a completed acquisition, and only this
   * signer can authorize this router, so a matching entry means our authorization paid.
   */
  async spentWithoutUs(vaultId: Hex): Promise<boolean> {
    const { publicClient, routerAddress, vaultSwapAddress, vaultKeeperAddress } = this.deps;
    const authorization = this.authorized.get(vaultId);
    // Never authorized, so nothing of ours could have executed.
    if (authorization === undefined) return false;

    // Filtered on all three indexed topics. `vaultId` alone would also match an acquisition of the
    // same vault through a different LLP or to a different keeper — neither of which is ours, and
    // neither of which spent our payer's WBTC.
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event: SWAP_EVENT,
      args: { vaultSwap: vaultSwapAddress, vaultId, onBehalfOf: vaultKeeperAddress },
      fromBlock: authorization.block,
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
  async authorizationExpired(vaultId: Hex, minedAtBlock: bigint): Promise<boolean> {
    const authorization = this.authorized.get(vaultId);
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
  }): Promise<ContractCall> {
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
    const deadline = block.timestamp + BigInt(this.deps.deadlineSeconds);

    // The router accepts nothing but a signature over this exact batch, and the EIP-712 domain
    // binds it to this chain and this router — the only replay bound the scheme has, since
    // `SelfCallRelayer` carries no nonce.
    // Recorded before signing: from here on an execution of this batch is possible, and this is
    // the earliest block one could appear in.
    this.authorized.set(vaultId, { block: block.number, deadline });

    const calls = [{ data, value: 0n }] as const;
    const signature = await executor.account.signTypedData({
      domain: arbitrageRouterDomain({
        chainId: executor.identity.chainId,
        verifyingContract: routerAddress,
      }),
      types: RELAYER_MESSAGE_TYPES,
      primaryType: "RelayerMessage",
      message: { calls, deadline },
    });

    return {
      address: routerAddress,
      abi: arbitrageRouterAbi,
      functionName: "relay",
      args: [{ calls, deadline }, signature],
    };
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
