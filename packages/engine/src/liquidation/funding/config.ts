import { VenueType } from "@repo/abis";
import type { Address } from "viem";
import type { FundingParams } from "./types";
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
 */
export function buildFundingParams(env: {
  LIQUIDATION_FUNDING: string;
  LIQUIDATION_ROUTER_ADDRESS?: string;
  FLASH_SWAP_VENUE_ADDRESS?: string;
  FLASH_SWAP_POOLS?: string;
  WBTC_FLASH_LOAN_ADDRESS?: string;
  WBTC_FLASH_LOAN_VENUE: string;
  FLASH_MAX_SLIPPAGE_BPS: string;
  WBTC_ADDRESS: string;
}): FundingParams {
  // The variables that mean nothing outside flash mode, and that flash mode cannot run without.
  // `WBTC_FLASH_LOAN_ADDRESS` belongs here even though only some liquidations draw on it: vaults are
  // indivisible, so the common case is seizing one worth more than the debt and owing the remainder
  // back as the WBTC fairness payment.
  //
  // `WBTC_FLASH_LOAN_VENUE` and `FLASH_MAX_SLIPPAGE_BPS` are absent on purpose — both carry schema
  // defaults, so by this point they are always populated and "did the operator set this?" is no
  // longer answerable for them.
  const flashOnly = [
    ["LIQUIDATION_ROUTER_ADDRESS", env.LIQUIDATION_ROUTER_ADDRESS],
    ["FLASH_SWAP_VENUE_ADDRESS", env.FLASH_SWAP_VENUE_ADDRESS],
    ["FLASH_SWAP_POOLS", env.FLASH_SWAP_POOLS],
    ["WBTC_FLASH_LOAN_ADDRESS", env.WBTC_FLASH_LOAN_ADDRESS],
  ] as const;
  const isSet = ([, value]: (typeof flashOnly)[number]) => value !== undefined && value.length > 0;

  if (env.LIQUIDATION_FUNDING !== "flash") {
    const stray = flashOnly.filter(isSet).map(([name]) => name);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but LIQUIDATION_FUNDING is "${env.LIQUIDATION_FUNDING}", so the flash configuration would be ignored and this bot would repay from its own inventory. Set LIQUIDATION_FUNDING=flash, or remove the flash-only variables.`
      );
    }
    return { mode: "inventory" };
  }

  const missing = flashOnly.filter((entry) => !isSet(entry)).map(([name]) => name);
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

  return {
    mode: "flash",
    routerAddress: env.LIQUIDATION_ROUTER_ADDRESS as Address,
    venues,
    maxSlippageBps: Number.parseInt(env.FLASH_MAX_SLIPPAGE_BPS, 10),
  };
}
