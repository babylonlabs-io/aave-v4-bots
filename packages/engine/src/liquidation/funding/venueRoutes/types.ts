import type { FlashData } from "@repo/abis";
import type { Address, PublicClient } from "viem";
import type { ReadCache } from "./cache";

/**
 * What one venue says about lending `amount` of its token right now.
 *
 * `repayWbtc` is the ranking key, not `costBps`. Every venue the router can repay without swaps is
 * repaid in WBTC — a flash loan lends WBTC itself, a flash swap takes WBTC as the pool's other side —
 * so for one token and one size an absolute WBTC figure compares any two sources. `costBps` cannot:
 * a flash swap's cost is measured against its own pool's spot price, and two pools for the same pair
 * can sit at different prices, so the pool with the worse `costBps` can still take less WBTC.
 */
export type VenueQuote =
  | {
      available: true;
      /** WBTC the venue takes back for the requested amount: principal plus premium, or the swap input. */
      repayWbtc: bigint;
      /** Reporting only. Signed, because a pool quoted against a moved spot price can read negative. */
      costBps: bigint;
      /**
       * The most the venue could lend, when that is one read. Absent for a pool: its maximum fill is
       * not a single figure, and the quote succeeding at all is what proves it fills this size.
       */
      liquidity?: bigint;
    }
  | { available: false; reason: string; liquidity?: bigint };

export type VenueKind = "flashLoan" | "flashSwap";

/** One place a token can be flash-borrowed from, able to price itself. */
export interface VenueSource {
  readonly kind: VenueKind;
  /** Stable across cycles: it names the source in logs, keys quote caches, and breaks ties. */
  readonly id: string;
  /** The token this source lends. */
  readonly token: Address;
  /** Position in configuration order among this token's sources. Lower wins a tie on `repayWbtc`. */
  readonly priority: number;
  /**
   * @throws on anything that is not a verdict about this size — an RPC failure, a revert other than
   *         the venue's own "cannot fill", a misconfigured pool. Answering `available: false` for those
   *         would read an outage as "nothing can fund this", and the planner treats the two differently.
   */
  quote(asset: Address, amount: bigint): Promise<VenueQuote>;
  /** The entry this source contributes to `flashDatas`. The router derives the amount itself. */
  flashData(): FlashData;
}

/** One source's answer, or the fact that it could not give one. */
export type QuoteOutcome =
  | { status: "quoted"; source: VenueSource; quote: VenueQuote }
  | { status: "unknown"; source: VenueSource; error: unknown };

/** A token the liquidation needs flash-borrowed, and roughly how much of it. */
export interface OwedLeg {
  token: Address;
  amount: bigint;
}

export interface PlannedLeg extends OwedLeg {
  source: VenueSource;
  /** The chosen quote's repayment. Absent on a degraded leg, where no source could be quoted. */
  quotedWbtcRepay?: bigint;
  costBps?: bigint;
  /** Every other source's outcome, kept for logs. */
  alternatives: readonly QuoteOutcome[];
}

/**
 * The planner's verdict on one token.
 *
 * `degraded` and `unfundable` are deliberately different results. `unfundable` means every source
 * answered and none can fill the size — a verdict on the candidate. `degraded` means no usable
 * answer came back and at least one source could not answer, which says nothing about the
 * candidate, so the first unanswered source by priority still goes to the probe.
 */
export type TokenPlan =
  | { kind: "ranked"; leg: PlannedLeg }
  | { kind: "degraded"; leg: PlannedLeg }
  | { kind: "unfundable"; token: Address; reasons: readonly string[] };

export interface UnfundableToken {
  token: Address;
  reasons: readonly string[];
}

export type RoutePlan =
  | { kind: "funded"; legs: readonly PlannedLeg[]; degraded: readonly Address[] }
  | { kind: "unfundable"; tokens: readonly UnfundableToken[] };

/** What a source reads through. Sources are built once at boot; everything here outlives a cycle. */
export interface SourceDeps {
  publicClient: PublicClient;
  wbtc: Address;
  /**
   * This cycle's read cache. Late-bound because sources are built once and the cache is not: each
   * cycle starts a fresh one, so no memoised read outlives the block it described.
   */
  cache: () => ReadCache;
  /** The UniswapV4 `V4Quoter`. Required by pool sources only. */
  quoter?: Address;
  /** The UniswapV4 `StateView`. Required by pool sources only. */
  stateView?: Address;
}
