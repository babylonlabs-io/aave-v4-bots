import { VenueType } from "@repo/abis";
import { readBalance } from "@repo/chain";
import { type Address, getAddress } from "viem";
import { assertQuotable } from "../venueRoutes/quote";
import type { SourceDeps, VenueSource } from "../venueRoutes/types";

export interface MorphoConfig {
  /** The Morpho singleton. */
  morpho: Address;
}

/**
 * A WBTC flash loan from Morpho.
 *
 * Morpho charges no flash-loan fee and lends from its whole token balance — every market's liquidity
 * and collateral combined — so the repayment is the principal, and the ceiling is one `balanceOf`.
 */
export function createMorphoSource(
  config: MorphoConfig,
  priority: number,
  deps: SourceDeps
): VenueSource {
  const morpho = getAddress(config.morpho);
  const wbtc = getAddress(deps.wbtc);
  const id = `morpho:${morpho}`;

  return {
    kind: "flashLoan",
    id,
    token: wbtc,
    priority,
    async quote(asset, amount) {
      assertQuotable(id, wbtc, asset, amount);
      const liquidity = await deps
        .cache()
        .get(`${id}:liquidity`, () => readBalance(deps.publicClient, wbtc, morpho));
      if (liquidity < amount) {
        return {
          available: false,
          reason: `Morpho holds ${liquidity} WBTC, below ${amount}`,
          liquidity,
        };
      }
      return { available: true, repayWbtc: amount, costBps: 0n, liquidity };
    },
    flashData: () => ({
      venueType: VenueType.Morpho,
      venueAddress: morpho,
      token: wbtc,
      swapData: "0x",
    }),
  };
}
