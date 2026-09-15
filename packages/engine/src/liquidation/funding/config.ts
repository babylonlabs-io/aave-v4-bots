import { VenueType } from "@repo/abis";
import type { Address } from "viem";
import type { FundingParams } from "./types";
import { parseFlashVenues } from "./venueRoutes/factory";
import { type FlashSwapVenue, type VenueRegistry, assertRegistryValid } from "./venues";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Turn a service's raw env into a `FundingParams`.
 *
 * Lives with the funding seam rather than in one service's config: both composition roots can run a
 * liquidation engine, so the vocabulary for choosing a mode — and the required-together rules that
 * make a flash setup coherent — belong next to the modes themselves, not next to whichever service
 * happened to need them first.
 */
/** `token:currency0:currency1:fee:tickSpacing[:hooks]` -> one flash-swap venue entry. */
function parseFlashSwapPools(spec: string, venueAddress: Address): FlashSwapVenue[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const [token, currency0, currency1, fee, tickSpacing, hooks] = entry.split(":");
      if (!token || !currency0 || !currency1 || !fee || !tickSpacing) {
        throw new Error(
          `FLASH_SWAP_POOLS entry "${entry}" must be token:currency0:currency1:fee:tickSpacing[:hooks]`
        );
      }
      return {
        token: token as Address,
        venueAddress,
        poolKey: {
          currency0: currency0 as Address,
          currency1: currency1 as Address,
          fee: Number.parseInt(fee, 10),
          tickSpacing: Number.parseInt(tickSpacing, 10),
          hooks: (hooks ?? ZERO_ADDRESS) as Address,
        },
      };
    });
}

type EnvVar = readonly [name: string, value: string | undefined];

const isSet = ([, value]: EnvVar) => value !== undefined && value.length > 0;
const namesOf = (vars: readonly EnvVar[]) => vars.map(([name]) => name);
const listed = (names: readonly string[]) =>
  `${names.join(", ")} ${names.length === 1 ? "is" : "are"}`;

/**
 * Resolve `LIQUIDATION_FUNDING` into the engine's funding parameter.
 *
 * Everything flash mode needs is optional in the schema (inventory mode must not require it), so the
 * coherence checks live here, and they run in **both** directions. `LIQUIDATION_FUNDING` is the only
 * thing that selects the mode — presence of the addresses never does — so each direction closes a
 * way for the process to end up funding liquidations differently than the operator intended:
 *
 * - flash mode with a variable missing would fall back to inventory, trading from balances they may
 *   never have funded;
 * - a complete flash setup with the flag left off would ignore all of it just as silently, and the
 *   only visible symptom is the bot spending its own tokens.
 *
 * Deciding the mode by presence instead would remove the first error but make the second the normal
 * semantics: deleting or mistyping one variable would then *change trading mode* rather than fail.
 *
 * Venue ranking repeats the same rule one level down. `FLASH_VENUE_RANKING` alone selects where
 * venues come from — the fixed variables, or `FLASH_VENUES` — and each set is refused when the flag
 * says the other one is in use, rather than read or quietly ignored.
 */
export function buildFundingParams(env: {
  LIQUIDATION_FUNDING: string;
  LIQUIDATION_ROUTER_ADDRESS?: string;
  FLASH_SWAP_VENUE_ADDRESS?: string;
  FLASH_SWAP_POOLS?: string;
  WBTC_FLASH_LOAN_ADDRESS?: string;
  WBTC_FLASH_LOAN_VENUE: string;
  FLASH_VENUE_RANKING?: string;
  FLASH_VENUES?: string;
  UNISWAP_V4_QUOTER_ADDRESS?: string;
  UNISWAP_V4_STATE_VIEW_ADDRESS?: string;
  FLASH_MAX_SLIPPAGE_BPS: string;
  WBTC_ADDRESS: string;
}): FundingParams {
  // The variables that mean nothing outside flash mode. `WBTC_FLASH_LOAN_VENUE` and
  // `FLASH_MAX_SLIPPAGE_BPS` are absent on purpose — both carry schema defaults, so by this point
  // they are always populated and "did the operator set this?" is no longer answerable for them.
  //
  // `WBTC_FLASH_LOAN_ADDRESS` is a fixed venue even though only some liquidations draw on it: vaults
  // are indivisible, so the common case is seizing one worth more than the debt and owing the
  // remainder back as the WBTC fairness payment.
  const router: EnvVar = ["LIQUIDATION_ROUTER_ADDRESS", env.LIQUIDATION_ROUTER_ADDRESS];
  const fixedVenues: EnvVar[] = [
    ["FLASH_SWAP_VENUE_ADDRESS", env.FLASH_SWAP_VENUE_ADDRESS],
    ["FLASH_SWAP_POOLS", env.FLASH_SWAP_POOLS],
    ["WBTC_FLASH_LOAN_ADDRESS", env.WBTC_FLASH_LOAN_ADDRESS],
  ];
  const rankedVenues: EnvVar[] = [
    ["FLASH_VENUES", env.FLASH_VENUES],
    ["UNISWAP_V4_QUOTER_ADDRESS", env.UNISWAP_V4_QUOTER_ADDRESS],
    ["UNISWAP_V4_STATE_VIEW_ADDRESS", env.UNISWAP_V4_STATE_VIEW_ADDRESS],
  ];
  const ranking = env.FLASH_VENUE_RANKING === "true";

  if (env.LIQUIDATION_FUNDING !== "flash") {
    const stray = namesOf([router, ...fixedVenues, ...rankedVenues].filter(isSet));
    // Only `true` counts as set: `false` asks for nothing flash mode would do.
    if (ranking) stray.push("FLASH_VENUE_RANKING");
    if (stray.length > 0) {
      throw new Error(
        `${listed(stray)} set but LIQUIDATION_FUNDING is "${env.LIQUIDATION_FUNDING}", so the flash configuration would be ignored and this bot would repay from its own inventory. Set LIQUIDATION_FUNDING=flash, or remove the flash-only variables.`
      );
    }
    return { mode: "inventory" };
  }

  const base = {
    mode: "flash" as const,
    routerAddress: env.LIQUIDATION_ROUTER_ADDRESS as Address,
    maxSlippageBps: Number.parseInt(env.FLASH_MAX_SLIPPAGE_BPS, 10),
  };

  if (!ranking) {
    // A complete ranked setup with the flag left off would otherwise fund every token from its one
    // fixed venue, and nothing would look wrong.
    const ignored = namesOf(rankedVenues.filter(isSet));
    if (ignored.length > 0) {
      throw new Error(
        `${listed(ignored)} set but FLASH_VENUE_RANKING is not "true", so they would be ignored and each token would use its one fixed venue. Set FLASH_VENUE_RANKING=true, or remove them.`
      );
    }
    const missing = namesOf([router, ...fixedVenues].filter((v) => !isSet(v)));
    if (missing.length > 0) {
      throw new Error(`LIQUIDATION_FUNDING=flash requires ${missing.join(", ")}`);
    }

    const venues: VenueRegistry = {
      wbtc: env.WBTC_ADDRESS as Address,
      flashSwaps: parseFlashSwapPools(
        env.FLASH_SWAP_POOLS as string,
        env.FLASH_SWAP_VENUE_ADDRESS as Address
      ),
      wbtcFlashLoan: {
        venueType: env.WBTC_FLASH_LOAN_VENUE === "aavev3" ? VenueType.AaveV3 : VenueType.Morpho,
        venueAddress: env.WBTC_FLASH_LOAN_ADDRESS as Address,
      },
    };
    // Surface a bad pool pairing at boot rather than on the first liquidatable position.
    assertRegistryValid(venues);
    return { ...base, venues };
  }

  // Ranking reads venues from `FLASH_VENUES` only. A fixed variable left beside it would be a second
  // list of venues that nothing reads.
  const leftover = namesOf(fixedVenues.filter(isSet));
  if (leftover.length > 0) {
    throw new Error(
      `${listed(leftover)} set but FLASH_VENUE_RANKING=true reads venues from FLASH_VENUES only, so they would be ignored. Move those venues into FLASH_VENUES and remove them.`
    );
  }
  const missing = namesOf([router, rankedVenues[0]].filter((v) => !isSet(v)));
  if (missing.length > 0) {
    throw new Error(
      `LIQUIDATION_FUNDING=flash with FLASH_VENUE_RANKING=true requires ${missing.join(", ")}`
    );
  }

  const entries = parseFlashVenues(env.FLASH_VENUES as string);
  if (entries.length === 0) throw new Error("FLASH_VENUES lists no venues");

  // Each entry's own arguments are checked where its sources are built, at engine construction —
  // still at boot. What is checked here is what the entry list alone decides.
  if (entries.some((e) => e.tag === "univ4")) {
    const lens = namesOf(rankedVenues.slice(1).filter((v) => !isSet(v)));
    if (lens.length > 0) {
      throw new Error(`FLASH_VENUES lists a univ4 pool, which requires ${lens.join(", ")}`);
    }
  }

  return {
    ...base,
    ranking: {
      entries,
      quoter: env.UNISWAP_V4_QUOTER_ADDRESS as Address | undefined,
      stateView: env.UNISWAP_V4_STATE_VIEW_ADDRESS as Address | undefined,
    },
  };
}
