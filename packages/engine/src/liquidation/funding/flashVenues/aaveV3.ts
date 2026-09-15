import { VenueType, aaveV3PoolAbi, erc20Abi } from "@repo/abis";
import { type Address, getAddress, zeroAddress } from "viem";
import { assertQuotable } from "../venueRoutes/quote";
import type { SourceDeps, VenueSource } from "../venueRoutes/types";

export interface AaveV3Config {
  /** The Aave v3 `Pool`. */
  pool: Address;
}

const PERCENTAGE_FACTOR = 10_000n;

/**
 * Aave's `PercentageMath.percentMulCeil`: the premium rounded up, which is how the pool charges it.
 * Rounding any other way under-quotes every premium that is not a whole unit.
 */
export function percentMulCeil(value: bigint, percentage: bigint): bigint {
  return (value * percentage + PERCENTAGE_FACTOR - 1n) / PERCENTAGE_FACTOR;
}

/**
 * A WBTC flash loan from an Aave v3 pool.
 *
 * Priced as the pool charges it: `FLASHLOAN_PREMIUM_TOTAL` basis points on the principal, rounded
 * up. Read per cycle rather than once at boot, because governance can change it.
 *
 * Bounded by what the pool checks, not by the WBTC its aToken holds. A flash loan must fit within
 * the aToken's total supply, and is then taken out of the reserve's virtual underlying balance,
 * which reverts below zero — so the smaller of the two is the ceiling. The aToken's WBTC balance is
 * neither: a donation raises it without raising the virtual balance, so it overstates what can be
 * borrowed.
 */
export function createAaveV3Source(
  config: AaveV3Config,
  priority: number,
  deps: SourceDeps
): VenueSource {
  const pool = getAddress(config.pool);
  const wbtc = getAddress(deps.wbtc);
  const id = `aavev3:${pool}`;
  const { publicClient } = deps;

  return {
    kind: "flashLoan",
    id,
    token: wbtc,
    priority,
    async quote(asset, amount) {
      assertQuotable(id, wbtc, asset, amount);
      const cache = deps.cache();

      const [premium, virtualBalance, aTokenSupply] = await Promise.all([
        cache.get(`${id}:premium`, () =>
          publicClient.readContract({
            address: pool,
            abi: aaveV3PoolAbi,
            functionName: "FLASHLOAN_PREMIUM_TOTAL",
          })
        ),
        cache.get(`${id}:virtualBalance`, () =>
          publicClient.readContract({
            address: pool,
            abi: aaveV3PoolAbi,
            functionName: "getVirtualUnderlyingBalance",
            args: [wbtc],
          })
        ),
        cache.get(`${id}:aTokenSupply`, async () => {
          const reserve = await publicClient.readContract({
            address: pool,
            abi: aaveV3PoolAbi,
            functionName: "getReserveData",
            args: [wbtc],
          });
          return publicClient.readContract({
            address: reserve.aTokenAddress,
            abi: erc20Abi,
            functionName: "totalSupply",
          });
        }),
      ]);

      const liquidity = virtualBalance < aTokenSupply ? virtualBalance : aTokenSupply;
      if (liquidity < amount) {
        return {
          available: false,
          reason: `the pool can lend ${liquidity} WBTC, below ${amount}`,
          liquidity,
        };
      }
      return {
        available: true,
        repayWbtc: amount + percentMulCeil(amount, premium),
        costBps: premium,
        liquidity,
      };
    },
    flashData: () => ({
      venueType: VenueType.AaveV3,
      venueAddress: pool,
      token: wbtc,
      swapData: "0x",
    }),
  };
}

/**
 * Checks at boot that every configured Aave v3 pool lists WBTC. Reads only.
 *
 * An unlisted asset has a virtual underlying balance of zero, so without this a wrong pool address
 * would pass every check and show up only as a venue that never funds anything.
 */
export async function assertWbtcListed(
  pools: readonly Address[],
  deps: Pick<SourceDeps, "publicClient" | "wbtc">
): Promise<void> {
  const wbtc = getAddress(deps.wbtc);
  const distinct = [...new Set(pools.map((p) => getAddress(p)))];

  const unlisted = (
    await Promise.all(
      distinct.map(async (pool) => {
        const reserve = await deps.publicClient.readContract({
          address: pool,
          abi: aaveV3PoolAbi,
          functionName: "getReserveData",
          args: [wbtc],
        });
        return getAddress(reserve.aTokenAddress) === zeroAddress ? pool : undefined;
      })
    )
  ).filter((pool) => pool !== undefined);

  if (unlisted.length > 0) {
    throw new Error(`WBTC ${wbtc} is not listed on Aave v3 pool ${unlisted.join(", ")}`);
  }
}
