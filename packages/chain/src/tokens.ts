import { erc20Abi } from "@repo/abis";
import type { Address, PublicClient } from "viem";

// ERC-20 balance / allowance / approval primitives — the leaf reads and writes behind the bots'
// inventory + approval logic. They are deliberately bare: retry belongs to the transport (see
// `instrumentedHttp`), so wrapping a read here would stack a second schedule on viem's own.
// Caching, thresholds and receipt-waiting stay in the service, where they differ per bot.

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** Read an ERC-20's symbol + decimals (immutable metadata). */
export async function readTokenMeta(client: PublicClient, token: Address): Promise<TokenMeta> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/** Per-address ERC-20 metadata cache — symbol/decimals never change, so fetch once. */
export class TokenMetaCache {
  private readonly cache = new Map<Address, TokenMeta>();

  async get(client: PublicClient, token: Address): Promise<TokenMeta> {
    const hit = this.cache.get(token);
    if (hit) return hit;
    const meta = await readTokenMeta(client, token);
    this.cache.set(token, meta);
    return meta;
  }
}

/**
 * ERC-20 balance of `owner`.
 *
 * `blockNumber` pins the read to one height. Worth doing whenever the answer is combined with
 * another read — a balance from one block and a log from another describe two different chains, and
 * the difference between them is money that appears to be spendable twice.
 */
export function readBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
  blockNumber?: bigint
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

/** ERC-20 allowance `owner → spender`. `blockNumber` pins it — see `readBalance`. */
export function readAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
  blockNumber?: bigint
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}
