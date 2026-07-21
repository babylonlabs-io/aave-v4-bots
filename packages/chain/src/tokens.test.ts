import { maxUint256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TokenMetaCache, approveMax, readAllowance, readBalance, readTokenMeta } from "./tokens";

const TOKEN = "0xtoken" as `0x${string}`;
const OTHER = "0xother" as `0x${string}`;
const OWNER = "0xowner" as `0x${string}`;
const SPENDER = "0xspender" as `0x${string}`;

type PublicClientArg = Parameters<typeof readBalance>[0];
type WalletArg = Parameters<typeof approveMax>[0];

function mockPublicClient() {
  return {
    readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "symbol":
          return Promise.resolve("WBTC");
        case "decimals":
          return Promise.resolve(8);
        case "balanceOf":
          return Promise.resolve(1000n);
        case "allowance":
          return Promise.resolve(500n);
        default:
          return Promise.resolve(0n);
      }
    }),
  };
}

describe("token reads", () => {
  it("readTokenMeta reads symbol + decimals", async () => {
    const client = mockPublicClient();
    const meta = await readTokenMeta(client as unknown as PublicClientArg, TOKEN);
    expect(meta).toEqual({ symbol: "WBTC", decimals: 8 });
  });

  describe("TokenMetaCache", () => {
    it("fetches once then serves the cached object", async () => {
      const client = mockPublicClient();
      const cache = new TokenMetaCache();

      const first = await cache.get(client as unknown as PublicClientArg, TOKEN);
      const second = await cache.get(client as unknown as PublicClientArg, TOKEN);

      expect(second).toBe(first); // same cached reference, no re-fetch
      expect(client.readContract).toHaveBeenCalledTimes(2); // symbol + decimals, once
    });

    it("caches per token address", async () => {
      const client = mockPublicClient();
      const cache = new TokenMetaCache();

      await cache.get(client as unknown as PublicClientArg, TOKEN);
      await cache.get(client as unknown as PublicClientArg, OTHER);

      expect(client.readContract).toHaveBeenCalledTimes(4); // 2 reads per distinct token
    });
  });

  it("readBalance calls balanceOf(owner)", async () => {
    const client = mockPublicClient();
    const balance = await readBalance(client as unknown as PublicClientArg, TOKEN, OWNER);

    expect(balance).toBe(1000n);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "balanceOf", args: [OWNER] })
    );
  });

  it("readAllowance calls allowance(owner, spender)", async () => {
    const client = mockPublicClient();
    const allowance = await readAllowance(
      client as unknown as PublicClientArg,
      TOKEN,
      OWNER,
      SPENDER
    );

    expect(allowance).toBe(500n);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "allowance", args: [OWNER, SPENDER] })
    );
  });

  it("approveMax approves spender for maxUint256 and returns the hash", async () => {
    const wallet = { writeContract: vi.fn().mockResolvedValue("0xhash") };
    const hash = await approveMax(wallet as unknown as WalletArg, TOKEN, SPENDER);

    expect(hash).toBe("0xhash");
    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "approve", args: [SPENDER, maxUint256] })
    );
  });
});
