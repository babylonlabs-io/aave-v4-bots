import type { TokenMetaCache } from "@repo/chain";
import type { ContractCall } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { RiskAction, RiskGate } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";
import type { Executor } from "../../shared/executor";
import type { LiquidatablePosition } from "../types";
import type { VenueRegistry } from "./venues";

/**
 * How a liquidation's repayment is funded.
 *
 * This is the seam between two genuinely different economics, not two spellings of one thing:
 *
 * - `inventory` repays out of the signer's own token inventory, calling `AaveAdapter`. That is why it
 *   must approve the adapter at boot, publish its balances to the risk gate every cycle, and
 *   declare a `spend` vector per action.
 * - `flash` calls `LiquidationRouter`, which borrows each debt token from a venue and repays itself
 *   from the seized collateral. The signer spends only gas — so there are no approvals, no
 *   inventory, and no `spend`; instead the probe yields a real WBTC `expectedProfit`.
 *
 * Deliberately **not** folded into `Executor`. That seam varies on how a transaction reaches the
 * chain (AUTO signs and broadcasts, MANUAL proposes and notifies) and takes an already-built call.
 * Funding decides *which call to build* and *what to declare*. The two axes compose — AUTO/MANUAL ×
 * inventory/flash — and nesting them would multiply implementations while dragging router ABIs, venue
 * registries and probe semantics into an executor that the arbitrage engine also uses.
 *
 * The division of labour with `LiquidationEngine` is equally deliberate: a strategy *describes*
 * risk (`RiskDeclaration`) but never opens or settles a slot, and never sees `Executor`. The engine
 * keeps the poll cycle, the risk slots, the commit, and the receipt/breaker taxonomy.
 */
export interface LiquidationFunding {
  readonly mode: "inventory" | "flash";

  /**
   * Boot-time setup, once per process.
   *
   * Inventory mode approves the adapter here, because the signer's own tokens are what the adapter
   * pulls. Flash mode has nothing to approve: the router grants the adapter its allowance out of its
   * own balance. Running the approvals regardless would grant a spender the signer never uses, and
   * under MANUAL would put an approval in front of an operator to sign for no reason.
   */
  prepare(): Promise<void>;

  /**
   * Per-cycle inventory publication to the risk gate, before any candidate is judged.
   *
   * Inventory mode must: the gate reserves each action's declared `spend` against these balances, and
   * fails closed on a token it has no figure for. Flash mode declares no spend, so it has nothing
   * to publish.
   */
  refreshInventory(): Promise<void>;

  /**
   * Filter the candidates down to those this mode can actually fund, and price them.
   *
   * The two modes vet incompatibly and cannot share an implementation: the inventory simulation calls
   * the adapter *as the signer*, which under flash funding holds none of the debt tokens, so every
   * candidate would "fail simulation".
   */
  vet(candidates: readonly LiquidationCandidate[]): Promise<FundedCandidate[]>;
}

/** A liquidatable position priced by the Lens, before any funding decision. */
export interface LiquidationCandidate {
  position: LiquidatablePosition;
  /** Per-reserve repay amounts, already buffered for interest accrual. */
  amounts: readonly bigint[];
  /** The LLP fairness payment (plus, in direct-redemption mode, the redemption fee). */
  wbtcPayment: bigint;
}

/** What a strategy tells the risk gate about an action. Never a slot — the engine owns those. */
export type RiskDeclaration = Pick<RiskAction, "spend" | "expectedProfit">;

/** A candidate this mode can fund, with the call to send and what it is worth. */
export interface FundedCandidate extends LiquidationCandidate {
  /** The exact call to commit — adapter in inventory mode, router in flash mode. */
  call: ContractCall;
  /**
   * Spread into the gate's action. The two modes populate opposite halves: inventory declares `spend`
   * and cannot price itself; flash declares `expectedProfit` and moves none of the signer's tokens.
   */
  risk: RiskDeclaration;
}

/** `funding: "flash"` — everything the router path needs that the inventory path does not. */
export interface FlashFundingParams {
  mode: "flash";
  /** The `LiquidationRouter` deployment whose `owner` is our executor identity. */
  routerAddress: Address;
  /** Where each token is flash-borrowed. Validated once at construction (`assertRegistryValid`). */
  venues: VenueRegistry;
  /**
   * How far the realised profit may fall below the probe's quote before the chain must revert, in
   * basis points.
   *
   * It derives `minWbtcProfit` on the real call. For flash-swap funding it is the **only** slippage
   * bound there is — the venue fills at whatever price the pool gives. `10_000` removes the bound.
   */
  maxSlippageBps: number;
}

/** Which funding mode to run, and its parameters. `inventory` needs none. */
export type FundingParams = FlashFundingParams | { mode: "inventory" };

/** The engine ports a strategy reports through. */
export interface FundingMetrics {
  recordError(type: string): void;
  recordSimulationFailed(): void;
}

/**
 * The execution collaborator, narrowed to what funding may touch.
 *
 * `identity` is a live property, so strategies read it per call rather than capturing it. They get
 * `ensureAllowance` and nothing else: committing is the engine's job, and a strategy that could
 * commit would be able to bypass the risk slot.
 */
export type FundingExecutor = Pick<Executor, "identity" | "ensureAllowance">;

/**
 * Everything a funding strategy draws on.
 *
 * `LiquidationEngineConfig` already satisfies all but the last two, so the engine spreads its own
 * config in rather than re-listing a dozen fields — the previous shape restated params the config
 * already held and wrapped three of them in closures, which is plumbing, not design.
 */
export interface FundingContext {
  publicClient: PublicClient;
  wbtcAddress: Address;
  adapterAddress: Address;
  llpAddress: Address;
  btcRedeemKey: Hex;
  isDirectRedemption: boolean;
  risk: RiskGate;
  logger: Logger;
  metrics: FundingMetrics;
  executor: FundingExecutor;
  /**
   * Late-bound on purpose: the borrowable-reserve list is discovered from the Spoke during
   * `prepare()`, after the strategy is built. The one thing here that genuinely cannot be a value.
   */
  debtTokens: () => readonly Address[];
  /** Shared with the engine so a token's symbol/decimals are read once per process, not per user. */
  tokenMeta: TokenMetaCache;
  /**
   * Which mode to build. Omitted ⇒ `inventory`, which is what a deployment that configures nothing
   * gets. Carried here rather than passed alongside so the choice and the collaborators it needs
   * cannot disagree — a separate argument could name one mode while this field named another.
   */
  funding?: FundingParams;
}
