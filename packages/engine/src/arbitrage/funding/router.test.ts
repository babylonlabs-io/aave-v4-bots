import { arbitrageRouterAbi } from "@repo/abis";
import { createRiskGate } from "@repo/risk";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AutoExecutor } from "../../shared/executor";
import { RouterFunding } from "./router";

const SIGNER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x2222222222222222222222222222222222222222" as const;
const WBTC = "0x3333333333333333333333333333333333333333" as const;
const ROUTER = "0x4444444444444444444444444444444444444444" as const;
const VAULT_SWAP = "0x5555555555555555555555555555555555555555" as const;
const KEEPER = "0x6666666666666666666666666666666666666666" as const;
const VAULT_ID = `0x${"7".repeat(64)}` as `0x${string}`;

const PREVIEW = { amountVault: 100n, amountWbtcToAcquire: 80n, amountProfitEst: 20_000n };

function build(
  opts: {
    signer?: string;
    payer?: string;
    wbtc?: string;
    llpWbtc?: string;
    balance?: bigint;
    allowance?: bigint;
    blockTimestamp?: bigint;
    blockNumber?: bigint;
    swapLogs?: unknown[];
  } = {}
) {
  const immutables: Record<string, unknown> = {
    signer: opts.signer ?? SIGNER,
    payer: opts.payer ?? PAYER,
    wbtc: opts.wbtc ?? WBTC,
  };
  const readContract = vi.fn(({ functionName }: { functionName: string }) => {
    if (functionName in immutables) return Promise.resolve(immutables[functionName]);
    if (functionName === "WBTC") return Promise.resolve(opts.llpWbtc ?? WBTC);
    if (functionName === "balanceOf") return Promise.resolve(opts.balance ?? 1_000n);
    if (functionName === "allowance") return Promise.resolve(opts.allowance ?? 500n);
    throw new Error(`unexpected read: ${functionName}`);
  });
  const risk = createRiskGate();
  const signTypedData = vi.fn().mockResolvedValue("0xsig");
  const getLogs = vi.fn().mockResolvedValue(opts.swapLogs ?? []);
  const recordFundingCapacity = vi.fn();
  const getBlock = vi.fn().mockResolvedValue({
    timestamp: opts.blockTimestamp ?? 1_700_000_000n,
    number: opts.blockNumber ?? 100n,
  });
  const funding = new RouterFunding({
    publicClient: {
      readContract,
      getBlock,
      getChainId: vi.fn().mockResolvedValue(31337),
      getLogs,
    } as unknown as ConstructorParameters<typeof RouterFunding>[0]["publicClient"],
    risk,
    metrics: { recordFundingCapacity },
    wbtcAddress: WBTC,
    vaultSwapAddress: VAULT_SWAP,
    maxSlippageBps: 100,
    routerAddress: ROUTER,
    vaultKeeperAddress: KEEPER,
    executor: {
      mode: "AUTO",
      identity: { from: SIGNER, chainId: 31337 },
      account: { address: SIGNER, signTypedData },
    } as unknown as AutoExecutor,
    deadlineSeconds: 120,
  });
  return { funding, risk, signTypedData, getLogs, recordFundingCapacity, getBlock };
}

describe("RouterFunding", () => {
  describe("prepare", () => {
    it("adopts the router's payer as the account it spends from", async () => {
      const { funding } = build();
      await funding.prepare();
      expect(funding.spend(42n)).toEqual({ owner: PAYER, token: WBTC, amount: 42n });
    });

    // Naming a payer before the router has been asked would silently reserve against the wrong
    // balance sheet, which is exactly what keying the ledger by owner exists to prevent.
    it("refuses to name a payer before the router has been read", () => {
      expect(() => build().funding.spend(1n)).toThrow(/before prepare\(\)/);
    });

    it("refuses a router that authorizes a different signer", async () => {
      await expect(
        build({ signer: "0x8888888888888888888888888888888888888888" }).funding.prepare()
      ).rejects.toThrow(
        /authorizes 0x8888888888888888888888888888888888888888, but this bot signs as/
      );
    });

    it("refuses a router denominated in a different token", async () => {
      await expect(
        build({ wbtc: "0x9999999999999999999999999999999999999999" }).funding.prepare()
      ).rejects.toThrow(/pays in 0x9999999999999999999999999999999999999999, but WBTC_ADDRESS is/);
    });

    // The router's WBTC is immutable; the LLP it pays is a per-call argument. A mismatch would
    // reject every acquisition on-chain with nothing naming the cause.
    it("refuses an LLP that settles in a different token than the router pays", async () => {
      await expect(
        build({ llpWbtc: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).funding.prepare()
      ).rejects.toThrow(/settles in 0xaaaa.*but ArbitrageRouter/i);
    });

    it("refuses to start without the treasury's approval", async () => {
      await expect(build({ allowance: 0n }).funding.prepare()).rejects.toThrow(
        /has not approved ArbitrageRouter/
      );
    });

    it("refuses to start with an empty treasury", async () => {
      await expect(build({ balance: 0n }).funding.prepare()).rejects.toThrow(/holds no WBTC/);
    });
  });

  describe("refreshInventory", () => {
    // The allowance binds as hard as the balance, and this process cannot raise it — publishing the
    // balance alone would admit acquisitions that revert on the transfer.
    it("publishes the lesser of balance and allowance", async () => {
      const { funding, risk } = build({ balance: 1_000n, allowance: 300n });
      await funding.prepare();
      await funding.refreshInventory();

      const spending = (amount: bigint) => ({
        kind: "vault-acquisition",
        subject: VAULT_ID,
        spend: [{ owner: PAYER, token: WBTC, amount }],
      });
      expect(risk.openSlot(spending(300n)).allowed).toBe(true);
      expect(risk.openSlot(spending(1n)).allowed).toBe(false);
    });

    // Both legs, not the minimum the gate gets: only one of them can be topped up without a new
    // approval, so an operator needs to see which is about to bind.
    it("reports the treasury's balance and its allowance separately", async () => {
      const { funding, recordFundingCapacity } = build({ balance: 1_000n, allowance: 300n });
      await funding.prepare();
      await funding.refreshInventory();

      expect(recordFundingCapacity).toHaveBeenCalledWith({
        owner: PAYER,
        balance: 1_000n,
        allowance: 300n,
      });
    });

    it("publishes the balance when it is the binding constraint", async () => {
      const { funding, risk } = build({ balance: 200n, allowance: 10_000n });
      await funding.prepare();
      await funding.refreshInventory();

      expect(
        risk.openSlot({
          kind: "vault-acquisition",
          subject: VAULT_ID,
          spend: [{ owner: PAYER, token: WBTC, amount: 201n }],
        }).allowed
      ).toBe(false);
    });
  });

  describe("buildAcquisition", () => {
    it("wraps the acquisition in a signed relay batch", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: 1_700_000_000n });
      await funding.prepare();

      const call = await funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });

      expect(call.address).toBe(ROUTER);
      expect(call.functionName).toBe("relay");

      const [message, signature] = call.args as [
        { calls: readonly { data: `0x${string}` }[]; deadline: bigint },
        string,
      ];
      expect(signature).toBe("0xsig");

      // The batch carries exactly the acquisition we priced, on behalf of the configured keeper.
      const inner = decodeFunctionData({ abi: arbitrageRouterAbi, data: message.calls[0].data });
      expect(inner.functionName).toBe("swapWbtcToVault");
      expect(inner.args?.[0]).toBe(VAULT_SWAP);
      expect(inner.args?.[1]).toBe(VAULT_ID);
      expect(inner.args?.[2]).toBe(KEEPER);
      expect(inner.args?.[4]).toBe(90n); // maxWbtcIn — the ceiling the gate admitted

      // Signed for this chain and this router; the domain is the only replay bound there is.
      expect(signTypedData).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryType: "RelayerMessage",
          domain: expect.objectContaining({ chainId: 31337, verifyingContract: ROUTER }),
        })
      );
    });

    // Chain time, not wall clock: the router compares against `block.timestamp`.
    it("expires the batch a bounded number of chain seconds out", async () => {
      const { funding } = build({ blockTimestamp: 1_700_000_000n });
      await funding.prepare();

      const call = await funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });

      const [message] = call.args as [{ deadline: bigint }];
      expect(message.deadline).toBe(1_700_000_120n);
    });

    // Not `RISK_MIN_PROFIT`: that floor is raw-BTC-denominated and already carried by `maxWbtcIn`.
    // This one only bounds how far the LLP's own oracle-denominated estimate may drift downward.
    it("floors the router's profit check at the preview less slippage", async () => {
      const { funding } = build();
      await funding.prepare();

      const call = await funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });

      const [message] = call.args as [{ calls: readonly { data: `0x${string}` }[] }];
      const inner = decodeFunctionData({ abi: arbitrageRouterAbi, data: message.calls[0].data });
      // 20_000 * (10_000 - 100) / 10_000
      expect(inner.args?.[3]).toBe(19_800n);
    });
  });

  describe("authorizationExpired", () => {
    /** Sign a batch, then report what chain time the transaction carrying it mined at. */
    async function minedAt(timestamp: bigint) {
      const h = build({ blockTimestamp: 1_700_000_000n, blockNumber: 100n });
      await h.funding.prepare();
      await h.funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });
      // The revert block's timestamp, which is what the router compared the deadline against.
      h.getBlock.mockResolvedValue({ timestamp, number: 200n });
      return h.funding;
    }

    // Deadline is 1_700_000_000 + 120. A batch that mines inside its window and still reverts was
    // refused on its merits, and must keep feeding the breaker.
    it("reports no expiry for a batch that mined inside its window", async () => {
      expect(await (await minedAt(1_700_000_119n)).authorizationExpired(VAULT_ID, 200n)).toBe(
        false
      );
    });

    it("reports expiry for a batch that mined after its deadline", async () => {
      expect(await (await minedAt(1_700_000_121n)).authorizationExpired(VAULT_ID, 200n)).toBe(true);
    });

    it("reports no expiry for a vault it never authorized", async () => {
      const { funding } = build();
      await funding.prepare();
      expect(await funding.authorizationExpired(VAULT_ID, 200n)).toBe(false);
    });
  });

  describe("spentWithoutUs", () => {
    /** Sign a batch for the vault, which is what makes an execution of ours possible at all. */
    async function authorized(opts: Parameters<typeof build>[0] = {}) {
      const h = build(opts);
      await h.funding.prepare();
      await h.funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });
      return h;
    }

    // `relay` is permissionless and the batch is visible before we broadcast — gas estimation puts
    // it in front of an RPC first — so a third party can execute it and leave our own tx reverting.
    it("reports a spend when the router shows our authorization acquired the vault", async () => {
      const { funding, getLogs } = await authorized({ swapLogs: [{ blockNumber: 99n }] });

      expect(await funding.spentWithoutUs(VAULT_ID)).toBe(true);
      // All three indexed topics: the same vault through another LLP, or to another keeper, is not
      // ours and did not spend our payer's WBTC.
      expect(getLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ROUTER,
          args: { vaultSwap: VAULT_SWAP, vaultId: VAULT_ID, onBehalfOf: KEEPER },
        })
      );
    });

    it("reports no spend when the vault was taken by someone else's funds", async () => {
      const { funding } = await authorized({ swapLogs: [] });
      expect(await funding.spentWithoutUs(VAULT_ID)).toBe(false);
    });

    // Nothing was ever signed for this vault, so no batch of ours can exist to have been executed —
    // and a log search would be answering a question about someone else's acquisition.
    it("reports no spend for a vault it never authorized", async () => {
      const { funding, getLogs } = build({ swapLogs: [{ blockNumber: 99n }] });
      await funding.prepare();

      expect(await funding.spentWithoutUs(VAULT_ID)).toBe(false);
      expect(getLogs).not.toHaveBeenCalled();
    });

    // Bounded by the block the authorization was signed at, not by converting the deadline into
    // blocks — that needs a block time we do not know, and guessing it too fast searches a window
    // narrower than the one the batch was live for.
    it("searches from the block the authorization was signed at", async () => {
      const { funding, getLogs } = await authorized({ blockNumber: 500n });
      await funding.spentWithoutUs(VAULT_ID);

      expect(getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 500n, toBlock: "latest" })
      );
    });
  });
});
