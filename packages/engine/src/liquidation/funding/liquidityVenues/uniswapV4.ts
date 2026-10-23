import {
  type PoolKey,
  VenueType,
  encodePoolKey,
  poolIdOf,
  uniswapV4SwapVenueAbi,
  v4QuoterAbi,
  v4StateViewAbi,
} from "@repo/abis";
import {
  type Address,
  BaseError,
  type ContractFunctionArgs,
  ContractFunctionRevertedError,
  type Hex,
  decodeErrorResult,
  getAddress,
} from "viem";
import { assertQuotable } from "../venueRoutes/quote";
import type { SourceDeps, VenueSource } from "../venueRoutes/types";
import { assertWbtcPairedWith } from "../venues";

const MAX_UINT128 = (1n << 128n) - 1n;
const Q192 = 1n << 192n;

export interface UniswapV4PoolConfig {
  /** The `UniswapV4SwapVenue` deployment bound to our router. */
  venueAddress: Address;
  /** The token this pool lends: its non-WBTC side. */
  token: Address;
  poolKey: PoolKey;
}

/**
 * A flash swap on one WBTC/<token> UniswapV4 pool, through `UniswapV4SwapVenue`.
 *
 * The venue swaps for an exact output with no price limit and repays the pool in WBTC, so the pool's
 * exact-output input for the size is the whole repayment. V4Quoter computes that by running the same
 * swap and reverting, which is why a quote is a simulated call rather than a view.
 *
 * @throws at construction on a pool that is not WBTC/<token> (I3), or without the quoter and
 *         StateView addresses.
 */
export function createUniswapV4Source(
  config: UniswapV4PoolConfig,
  priority: number,
  deps: SourceDeps
): VenueSource {
  const { publicClient, quoter, stateView } = deps;
  if (quoter === undefined || stateView === undefined) {
    throw new Error("a UniswapV4 venue needs both the V4 quoter and the StateView address");
  }
  const wbtc = getAddress(deps.wbtc);
  const token = getAddress(config.token);
  const venueAddress = getAddress(config.venueAddress);
  const { poolKey } = config;
  assertWbtcPairedWith(poolKey, token, wbtc);

  const poolId = poolIdOf(poolKey);
  const id = `univ4:${venueAddress}:${poolId}`;
  // The venue's own derivation: borrowing currency1 means paying currency0. Quoting the other
  // direction would price a different trade from the one the router makes.
  const zeroForOne = getAddress(poolKey.currency1) === token;

  const quoteAmountIn = async (amount: bigint): Promise<bigint | undefined> => {
    // Typed up front: inferred inside the call, viem narrows the pool key's slot to `never`.
    const args: ContractFunctionArgs<typeof v4QuoterAbi, "nonpayable", "quoteExactOutputSingle"> = [
      // Empty hook data, because the venue swaps with empty hook data: a hook that reads it would
      // otherwise price a swap the venue never makes.
      { poolKey, zeroForOne, exactAmount: amount, hookData: "0x" },
    ];
    try {
      const { result } = await publicClient.simulateContract({
        address: quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactOutputSingle",
        args,
      });
      return result[0];
    } catch (error) {
      if (isNotEnoughLiquidity(error, poolId)) return undefined;
      throw error;
    }
  };

  const readSqrtPriceX96 = async (): Promise<bigint> => {
    const [sqrtPriceX96] = await publicClient.readContract({
      address: stateView,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
    });
    if (sqrtPriceX96 === 0n) throw new Error(`venue ${id}: pool is not initialized`);
    return sqrtPriceX96;
  };

  return {
    kind: "flashSwap",
    id,
    token,
    priority,
    async quote(asset, amount) {
      assertQuotable(id, token, asset, amount);
      if (amount > MAX_UINT128) {
        throw new Error(`venue ${id}: amount ${amount} exceeds the quoter's uint128`);
      }
      const [amountIn, sqrtPriceX96] = await Promise.all([
        quoteAmountIn(amount),
        deps.cache().get(`${id}:sqrtPriceX96`, readSqrtPriceX96),
      ]);
      if (amountIn === undefined) return { available: false, reason: "NotEnoughLiquidity" };
      return {
        available: true,
        repayWbtc: amountIn,
        costBps: flashSwapCostBps(amountIn, amount, sqrtPriceX96, zeroForOne),
      };
    },
    flashData: () => ({
      venueType: VenueType.UniswapV4FlashSwap,
      venueAddress,
      token,
      swapData: encodePoolKey(poolKey),
    }),
  };
}

/**
 * Whether a quote failed because this pool cannot fill the size — the only failure that is a verdict.
 *
 * V4Quoter catches the swap's revert and re-raises anything that is not its own quote result as
 * `UnexpectedRevertBytes(inner)`, so the verdict sits one layer down. It must also name this pool: a
 * `NotEnoughLiquidity` for another pool id means the call did not price the pool that was asked about.
 */
export function isNotEnoughLiquidity(error: unknown, poolId: Hex): boolean {
  const revert =
    error instanceof BaseError
      ? error.walk((e) => e instanceof ContractFunctionRevertedError)
      : null;
  if (!(revert instanceof ContractFunctionRevertedError) || revert.data === undefined) return false;

  const samePool = (value: unknown) =>
    typeof value === "string" && value.toLowerCase() === poolId.toLowerCase();

  const { errorName, args } = revert.data;
  if (errorName === "NotEnoughLiquidity") return samePool(args?.[0]);
  if (errorName !== "UnexpectedRevertBytes") return false;

  try {
    const inner = decodeErrorResult({ abi: v4QuoterAbi, data: args?.[0] as Hex });
    return (
      inner.errorName === "NotEnoughLiquidity" &&
      samePool((inner.args as readonly unknown[] | undefined)?.[0])
    );
  } catch {
    return false;
  }
}

/**
 * How far `amountIn` exceeds what `amountOut` is worth at the pool's spot price, in basis points.
 *
 * Reporting only: it measures against this pool's own spot, so it cannot compare two pools, and a
 * moved or manipulated spot moves it. The LP fee is already inside `amountIn`. Signed, and truncated
 * toward zero.
 *
 * `sqrtPriceX96² / 2^192` is currency1 per currency0 in raw units, so the spot value of the borrowed
 * side in WBTC is `amountOut * 2^192 / sqrtPriceX96²` when WBTC is currency0, and
 * `amountOut * sqrtPriceX96² / 2^192` when it is currency1 — rounded up, so it is never zero.
 *
 * @param wbtcIsCurrency0 True exactly when the swap is zeroForOne.
 */
export function flashSwapCostBps(
  amountIn: bigint,
  amountOut: bigint,
  sqrtPriceX96: bigint,
  wbtcIsCurrency0: boolean
): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error(`sqrtPriceX96 must be positive, got ${sqrtPriceX96}`);
  if (amountOut <= 0n) throw new Error(`amountOut must be positive, got ${amountOut}`);
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const midIn = wbtcIsCurrency0
    ? ceilDiv(amountOut * Q192, priceX192)
    : ceilDiv(amountOut * priceX192, Q192);
  return ((amountIn - midIn) * 10_000n) / midIn;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * Checks the quoter, StateView and every configured swap venue sit on one pool manager.
 *
 * Each is a separate deployment with its own immutable pool manager. A quoter on another manager
 * than the venue prices a different pool under the same key — a price the router never trades at.
 * Reads only.
 */
export async function assertSharedPoolManager(
  venueAddresses: readonly Address[],
  deps: Pick<SourceDeps, "publicClient" | "quoter" | "stateView">
): Promise<void> {
  const { publicClient, quoter, stateView } = deps;
  if (quoter === undefined || stateView === undefined) {
    throw new Error("a UniswapV4 venue needs both the V4 quoter and the StateView address");
  }
  const venues = [...new Set(venueAddresses.map((a) => getAddress(a)))];

  const [quoterManager, stateViewManager, ...venueManagers] = await Promise.all([
    publicClient.readContract({ address: quoter, abi: v4QuoterAbi, functionName: "poolManager" }),
    publicClient.readContract({
      address: stateView,
      abi: v4StateViewAbi,
      functionName: "poolManager",
    }),
    ...venues.map((venue) =>
      publicClient.readContract({
        address: venue,
        abi: uniswapV4SwapVenueAbi,
        functionName: "uniV4PoolManager",
      })
    ),
  ]);

  const expected = getAddress(quoterManager);
  const others: [string, Address][] = [
    [`StateView ${getAddress(stateView)}`, stateViewManager],
    ...venues.map((venue, i): [string, Address] => [`swap venue ${venue}`, venueManagers[i]]),
  ];
  const mismatched = others.filter(([, manager]) => getAddress(manager) !== expected);
  if (mismatched.length > 0) {
    throw new Error(
      `the V4 quoter ${getAddress(quoter)} uses pool manager ${expected}, but ${mismatched
        .map(([what, manager]) => `${what} uses ${getAddress(manager)}`)
        .join("; ")}`
    );
  }
}
