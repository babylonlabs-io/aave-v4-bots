// UniswapV4 `PoolKey` — the ABI shape the flash-swap venue decodes out of `FlashData.swapData`
// (`abi.decode(swapData, (PoolKey))` in contracts/WrappedVenue/UniswapV4SwapVenue.sol).
//
// This lives here rather than with the engine that happens to use it first: it is a contract
// interface, and the component order below IS the encoding. Getting it wrong produces bytes that
// decode into a different pool without ever failing a type check.

import { type Address, type Hex, encodeAbiParameters } from "viem";

/**
 * The five fields of `PoolKey`, in declaration order.
 *
 * Order is the ABI, so this must match `lib/v4-periphery/lib/v4-core/src/types/PoolKey.sol`:
 * `currency0, currency1, fee (uint24), tickSpacing (int24), hooks`.
 */
export const poolKeyAbiParameters = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/**
 * A UniswapV4 pool's identity.
 *
 * `currency0`/`currency1` are ordered by address, not by any role — which side a given token lands
 * on is a property of the addresses, never something the caller chooses.
 */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** `abi.encode(poolKey)` — the `swapData` payload for a `UniswapV4FlashSwap` venue. */
export function encodePoolKey(poolKey: PoolKey): Hex {
  return encodeAbiParameters(poolKeyAbiParameters, [poolKey]);
}
