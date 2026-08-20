import {
  type FlashData,
  type LiquidationData,
  MIN_PROFIT_REVERT_TAG,
  type SwapData,
  type VenueDebt,
  liquidationRouterAbi,
} from "@repo/abis";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type PublicClient,
  getAddress,
} from "viem";

/**
 * Reads back what a flash-funded liquidation would actually realise, by running it.
 *
 * `LiquidationRouter.liquidate` with `minWbtcProfit = MIN_PROFIT_REVERT_TAG` performs the whole
 * liquidation and then deliberately reverts with `BelovedError(netWbtcBeforePayment, debts)`. That
 * revert is the only source of two numbers we cannot get anywhere else: the WBTC the liquidation
 * realised, and the exact amount each venue wants back. No lens view returns either.
 *
 * Because it reverts, the simulation leaves no state behind — but it is still only a quote against
 * one block: by the time the transaction mines, the pool or the debt may have moved.
 */

/**
 * The arguments that turn `liquidate` into a read-only probe: it runs the whole liquidation and then
 * reverts with `BelovedError`. Never send this — `MIN_PROFIT_REVERT_TAG` guarantees the revert.
 */
export function probeArgs(
  borrower: Address,
  flashDatas: readonly FlashData[]
): [LiquidationData, FlashData[], SwapData[]] {
  return [{ borrower, minWbtcProfit: MIN_PROFIT_REVERT_TAG }, [...flashDatas], []];
}

export type ProbeResult =
  | { kind: "quote"; netWbtcBeforePayment: bigint; debts: VenueDebt[] }
  /**
   * The router reverted with something other than `BelovedError` — the position is gone, a venue is
   * dry, a pool key is wrong. Not a bug: a candidate we cannot fund right now.
   */
  | { kind: "unavailable"; reason: string };

/** A probe that came back in a shape we cannot act on. Distinct from "cannot fund this candidate". */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export async function probeLiquidation(args: {
  publicClient: PublicClient;
  router: Address;
  /** Must be the router's `owner`; `liquidate` is `auth`-gated and would revert for anyone else. */
  owner: Address;
  borrower: Address;
  flashDatas: readonly FlashData[];
}): Promise<ProbeResult> {
  const { publicClient, router, owner, borrower, flashDatas } = args;

  try {
    await publicClient.simulateContract({
      address: router,
      abi: liquidationRouterAbi,
      functionName: "liquidate",
      args: probeArgs(borrower, flashDatas),
      account: owner,
    });
  } catch (error) {
    const revert =
      error instanceof BaseError
        ? error.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;

    if (!(revert instanceof ContractFunctionRevertedError)) {
      // No decodable revert at all — an RPC failure, not a verdict about the candidate. Surfacing
      // this as `unavailable` would silently turn an outage into "nothing is liquidatable".
      throw new ProbeError(
        `probe did not produce a contract revert: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (revert.data?.errorName !== "BelovedError") {
      return {
        kind: "unavailable",
        reason: revert.data?.errorName ?? revert.reason ?? revert.shortMessage,
      };
    }

    const [netWbtcBeforePayment, debts] = revert.data.args as readonly [
      bigint,
      readonly VenueDebt[],
    ];

    return {
      kind: "quote",
      netWbtcBeforePayment,
      debts: debts.map((d) => ({
        token: getAddress(d.token),
        venue: getAddress(d.venue),
        amount: d.amount,
      })),
    };
  }

  // `MIN_PROFIT_REVERT_TAG` makes the revert unconditional, so reaching here means we called
  // something that is not the router we think it is.
  throw new ProbeError("probe returned successfully; expected BelovedError");
}

export interface ProfitQuote {
  /** WBTC the liquidation realised, net of any balance the router already held. */
  realisedWbtc: bigint;
  /** Everything owed back to venues, all WBTC-denominated in this configuration. */
  totalVenueDebt: bigint;
  /** `realisedWbtc - totalVenueDebt`. Negative means the liquidation loses money. */
  expectedProfit: bigint;
}

/**
 * Turns a probe quote into a profit figure.
 *
 * @param routerWbtcBefore The router's WBTC balance before the call. `netWbtcBeforePayment` is a
 *        raw `balanceOf`, so anything already sitting in the router inflates it and would be
 *        double-counted as profit we did not earn. Normally zero — the router sweeps itself empty —
 *        but nothing stops someone transferring tokens to it.
 * @throws ProbeError if any venue wants a token other than WBTC, which means the `flashDatas` was
 *         built wrong — a venue was chosen that repays in something other than WBTC, which would
 *         have required the `swapDatas` this configuration never builds.
 */
export function quoteProfit(
  probe: { netWbtcBeforePayment: bigint; debts: readonly VenueDebt[] },
  wbtc: Address,
  routerWbtcBefore = 0n
): ProfitQuote {
  const foreign = probe.debts.filter((d) => getAddress(d.token) !== getAddress(wbtc));
  if (foreign.length > 0) {
    throw new ProbeError(
      `venue debt in a non-WBTC token (${foreign.map((d) => d.token).join(", ")}); this flashDatas needs swapDatas we do not build`
    );
  }

  const realisedWbtc = probe.netWbtcBeforePayment - routerWbtcBefore;
  const totalVenueDebt = probe.debts.reduce((sum, d) => sum + d.amount, 0n);

  return { realisedWbtc, totalVenueDebt, expectedProfit: realisedWbtc - totalVenueDebt };
}

/**
 * The on-chain floor to send with the real transaction.
 *
 * Two different bounds, and the floor is whichever binds harder:
 *
 * - `maxSlippageBps` — how far the result may decay from the quote. A *fraction*, because a fixed
 *   WBTC amount is meaningless on a large position and blocking on a small one. This is the room
 *   the transaction may lose to movement between the quote and the mine, and for flash-swap funding
 *   it is the *only* slippage bound there is: the venue swaps at whatever price the pool gives.
 * - `minProfit` — the operator's absolute floor (`RISK_MIN_PROFIT`), when set. The risk gate already
 *   checks it, but only against the *quote*, and only before the transaction is sent. On its own
 *   that leaves the gate admitting an action as worth ≥ `minProfit` which then settles below it:
 *   quote 1.1M sats against a 1M floor at 20% slippage bounds the chain at 880k. Carrying it here
 *   makes the declared minimum true at execution instead of merely at admission.
 *
 * Taking the maximum is what composes them: slippage protects large positions proportionally, the
 * absolute floor stops any of them settling below what the operator said was worth doing.
 *
 * @param maxSlippageBps Quoted profit the transaction may give up, in bps. 10_000 => no bound.
 * @param minProfit Absolute floor in sats, or undefined when the operator set none.
 */
export function minWbtcProfitFloor(
  expectedProfit: bigint,
  maxSlippageBps: number,
  minProfit?: bigint
): bigint {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    throw new ProbeError(`maxSlippageBps must be an integer in [0, 10000], got ${maxSlippageBps}`);
  }
  if (expectedProfit <= 0n) return 0n; // nothing to protect; the caller should not be sending this
  const afterSlippage = (expectedProfit * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  // The gate refused anything quoting below `minProfit`, so this never floors above the quote.
  return minProfit !== undefined && minProfit > afterSlippage ? minProfit : afterSlippage;
}
