import { erc20Abi } from "@repo/abis";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  maxUint256,
} from "viem";

// ERC-20 balance / allowance / approval primitives — the leaf reads and writes
// behind the bots' inventory + approval logic. Retry, caching, thresholds, and
// receipt-waiting stay in the service (they differ per bot); these are the shared
// building blocks (proposal §7 — capital).

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

/** ERC-20 balance of `owner`. */
export function readBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** ERC-20 allowance `owner → spender`. */
export function readAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

/** Approve `spender` for the max uint256 amount of `token`. Returns the tx hash. */
export function approveMax(
  wallet: WalletClient<Transport, Chain, Account>,
  token: Address,
  spender: Address
): Promise<Hex> {
  return wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
}
