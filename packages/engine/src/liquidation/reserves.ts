import { adapterAbi, spokeAbi } from "@repo/abis";
import type { Logger } from "@repo/logger";
import type { Address, PublicClient } from "viem";
import { isBorrowableReserve } from "./domain";

/**
 * One Spoke reserve, at the id the protocol knows it by.
 *
 * The id is the whole point of this type. `AaveAdapterLens.estimateLiquidation` returns repay
 * amounts indexed by reserve id over **every** reserve, and the adapter pulls `amounts[i]` in
 * reserve `i`'s underlying (`_getAllReserves` → `__transferIn_liquidationAmounts`). A list of
 * *tokens* cannot express that mapping once any reserve is skipped, which is why nothing that has
 * to name the token behind an amount may work from a filtered list.
 */
export interface SpokeReserve {
  /** Reserve id — the index `estimateLiquidation`'s amounts are keyed by. */
  id: number;
  /** The ERC-20 the adapter pulls for this reserve. */
  token: Address;
  /**
   * Whether a borrower may take new debt here, as of the read this came from.
   *
   * `updateReserveConfig` can flip it without the reserve count moving, which is why the list is
   * read afresh each cycle rather than cached: a reserve that became borrowable is one whose token
   * the signer must now hold and approve, and a stale `false` costs every liquidation that owes it.
   *
   * It decides *inventory* — what to hold and approve — and nothing else. It is deliberately not a
   * liquidation precondition: the flag restricts borrowing, while the adapter repays existing debt
   * with a plain `transferFrom` and takes vaultBTC collateral, so debt on a frozen reserve is still
   * liquidatable by anyone holding the token.
   */
  borrowable: boolean;
}

/**
 * Every reserve the Spoke lists, in id order — the index space `estimateLiquidation` speaks in.
 *
 * Dense and complete by construction: `Spoke.addReserve` assigns `reserveId = _reserveCount++` and
 * writes the reserve once, so ids run `0..count-1`, are never reused, and a reserve's underlying
 * never changes after creation. `id → token` is therefore stable for the life of a deployment;
 * `borrowable` is not, and neither is the length.
 */
export interface SpokeReserves {
  /** The Spoke the adapter is wired to, read from the adapter rather than configured. */
  spoke: Address;
  /** Index i is reserve id i. */
  reserves: readonly SpokeReserve[];
}

/**
 * Ceiling on how many reserves this will enumerate.
 *
 * `getReserveCount` is a number read from an address the operator configured, and everything after
 * it is a loop. Point `ADAPTER_ADDRESS` at the wrong contract and the answer can be any 256-bit
 * value — which is not a slow boot, it is a process that allocates until it dies, before it has
 * logged anything an operator could act on. A Spoke listing more than this is not a deployment
 * anyone runs; refusing it names the misconfiguration instead.
 */
export const MAX_SPOKE_RESERVES = 256n;

/** The distinct tokens a borrower can still owe — what an inventory-funded bot must hold and approve. */
export function borrowableTokens(topology: SpokeReserves): Address[] {
  const seen = new Set<string>();
  const tokens: Address[] = [];
  for (const reserve of topology.reserves) {
    if (!reserve.borrowable) continue;
    const k = reserve.token.toLowerCase();
    // Two reserves can share an underlying (same token on a different hub), and the balance and
    // allowance behind them are one and the same.
    if (seen.has(k)) continue;
    seen.add(k);
    tokens.push(reserve.token);
  }
  return tokens;
}

/**
 * Enumerate the Spoke's reserves — boot-time chain discovery, not engine policy, so it reads as a
 * function rather than a method.
 *
 * Returns **every** reserve rather than the borrowable subset it used to, because two different
 * questions are asked of this: *"what can I be asked to pay?"* (the borrowable tokens — approvals,
 * balances) and *"which token is this amount denominated in?"* (the reserve at that id). The second
 * cannot be answered from the first, and answering it from a filtered list is wrong the moment a
 * non-borrowable reserve sorts before a borrowable one — silently, in the direction of declaring
 * one token's outflow against another's balance.
 */
export async function discoverSpokeReserves(deps: {
  publicClient: PublicClient;
  adapterAddress: Address;
  logger: Logger;
  /** Resolved per reserve purely so the log names the token rather than an address. */
  tokenSymbol: (token: Address) => Promise<string>;
  /** The list this replaces, if any. Logging is silent unless it differs — this runs every cycle. */
  previous?: SpokeReserves;
}): Promise<SpokeReserves> {
  const { publicClient, adapterAddress, logger, tokenSymbol, previous } = deps;

  const spoke = await publicClient.readContract({
    address: adapterAddress,
    abi: adapterAbi,
    functionName: "BTC_VAULT_CORE_SPOKE",
  });

  const reserveCount = await publicClient.readContract({
    address: spoke,
    abi: spokeAbi,
    functionName: "getReserveCount",
  });
  if (reserveCount > MAX_SPOKE_RESERVES) {
    throw new Error(
      `Spoke ${spoke} reports ${reserveCount} reserves, past the ${MAX_SPOKE_RESERVES} this bot will enumerate — check that ADAPTER_ADDRESS points at the AaveAdapter for this deployment`
    );
  }
  const reserves: SpokeReserve[] = [];
  for (let i = 0n; i < reserveCount; i++) {
    const reserve = await publicClient.readContract({
      address: spoke,
      abi: spokeAbi,
      functionName: "getReserve",
      args: [i],
    });
    reserves.push({
      id: Number(i),
      token: reserve.underlying,
      borrowable: isBorrowableReserve(reserve.flags),
    });
  }

  const topology = { spoke, reserves };
  if (!sameReserves(previous, topology)) {
    logger.info(`Spoke ${spoke} lists ${reserveCount} reserve(s):`);
    for (const reserve of reserves) {
      logger.info(
        `  Reserve ${reserve.id}: ${await tokenSymbol(reserve.token)} (${reserve.token})${
          reserve.borrowable ? " - borrowable" : ""
        }`
      );
    }
    if (reserves.every((reserve) => !reserve.borrowable)) {
      logger.warn("No borrowable reserves found on Spoke");
    }
  }
  return topology;
}

/** Whether two reads describe the same Spoke in the same state — ids, tokens and flags alike. */
function sameReserves(a: SpokeReserves | undefined, b: SpokeReserves): boolean {
  if (!a || a.spoke !== b.spoke || a.reserves.length !== b.reserves.length) return false;
  return a.reserves.every((reserve, i) => {
    const other = b.reserves[i];
    return reserve.token === other.token && reserve.borrowable === other.borrowable;
  });
}
