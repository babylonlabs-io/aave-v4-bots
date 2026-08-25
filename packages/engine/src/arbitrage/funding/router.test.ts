import { arbitrageRouterAbi } from "@repo/abis";
import { createRiskGate } from "@repo/risk";
import { decodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AutoExecutor } from "../../shared/executor";
import { RouterFunding } from "./router";

const SIGNER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x2222222222222222222222222222222222222222" as const;
/** A spend against the treasury's WBTC — the account the gate keys the router's capacity under. */
const SPEND = (amount: bigint) => ({ owner: PAYER, token: WBTC, amount });
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
    /** Chain head when `spentWithoutUs` scans; defaults to the authorization's own block. */
    headBlock?: bigint;
    /** The address transactions come from, when it differs from the account that signs. */
    txIdentity?: string;
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
  const getBlockNumber = vi.fn().mockResolvedValue(opts.headBlock ?? opts.blockNumber ?? 100n);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const funding = new RouterFunding({
    publicClient: {
      readContract,
      getBlock,
      getBlockNumber,
      getChainId: vi.fn().mockResolvedValue(31337),
      getLogs,
    } as unknown as ConstructorParameters<typeof RouterFunding>[0]["publicClient"],
    risk,
    metrics: { recordFundingCapacity },
    logger,
    wbtcAddress: WBTC,
    vaultSwapAddress: VAULT_SWAP,
    maxSlippageBps: 100,
    routerAddress: ROUTER,
    vaultKeeperAddress: KEEPER,
    executor: {
      mode: "AUTO",
      identity: { from: opts.txIdentity ?? SIGNER, chainId: 31337 },
      account: { address: SIGNER, signTypedData },
    } as unknown as AutoExecutor,
    deadlineSeconds: 120,
  });
  return {
    funding,
    risk,
    signTypedData,
    getLogs,
    recordFundingCapacity,
    getBlock,
    readContract,
    logger,
  };
}

describe("RouterFunding", () => {
  describe("prepare", () => {
    it("adopts the router's payer as the account it spends from", async () => {
      const { funding } = build();
      await funding.prepare();
      // `accounting: "caller"` is load-bearing, not decoration: this mode keeps counting the batch
      // after the slot closes, and the gate must not hold the same WBTC a second time.
      expect(funding.spend(42n)).toEqual({
        owner: PAYER,
        token: WBTC,
        amount: 42n,
        accounting: "caller",
      });
    });

    // Two reasons, either sufficient. Accounting: this mode publishes the treasury's capacity net
    // of what signed batches are holding, and `setAvailable` is last-writer-wins — a liquidation
    // engine in the same process publishes the signer's raw WBTC balance under the same key, so
    // one shared address erases the subtraction. Design: with one address the mode buys nothing
    // inventory funding does not.
    it("refuses a router whose treasury is the bot's own signer", async () => {
      const { funding } = build({ payer: SIGNER });
      await expect(funding.prepare()).rejects.toThrow(/this bot's own signer/);
    });

    // The two can differ — an executor built over a custom sender carries its own transaction
    // identity — and it is the *signing* account that makes the treasury a hot wallet.
    it("refuses it when the treasury is the signing account under another tx identity", async () => {
      const OTHER = "0x9999999999999999999999999999999999999999";
      const { funding } = build({ payer: SIGNER, txIdentity: OTHER });
      await expect(funding.prepare()).rejects.toThrow(/this bot's own signer/);
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
        authorized: 0n,
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

      const { call } = await funding.buildAcquisition({
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

      const { call } = await funding.buildAcquisition({
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

      const { call } = await funding.buildAcquisition({
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
      const { authorizationId } = await h.funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });
      // The revert block's timestamp, which is what the router compared the deadline against.
      h.getBlock.mockResolvedValue({ timestamp, number: 200n });
      return { funding: h.funding, authorizationId };
    }

    // Deadline is 1_700_000_000 + 120. A batch that mines inside its window and still reverts was
    // refused on its merits, and must keep feeding the breaker.
    it("reports no expiry for a batch that mined inside its window", async () => {
      const { funding, authorizationId } = await minedAt(1_700_000_119n);
      expect(await funding.authorizationExpired(authorizationId, 200n)).toBe(false);
    });

    it("reports expiry for a batch that mined after its deadline", async () => {
      const { funding, authorizationId } = await minedAt(1_700_000_121n);
      expect(await funding.authorizationExpired(authorizationId, 200n)).toBe(true);
    });

    it("reports no expiry for an authorization it never created", async () => {
      const { funding } = build();
      await funding.prepare();
      expect(await funding.authorizationExpired(undefined, 200n)).toBe(false);
    });
  });

  describe("spentWithoutUs", () => {
    /** Sign a batch for the vault, which is what makes an execution of ours possible at all. */
    async function authorized(opts: Parameters<typeof build>[0] = {}) {
      const h = build(opts);
      await h.funding.prepare();
      const { authorizationId } = await h.funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });
      return { ...h, authorizationId };
    }

    // `relay` is permissionless and the batch is visible before we broadcast — gas estimation puts
    // it in front of an RPC first — so a third party can execute it and leave our own tx reverting.
    it("reports a spend when the router shows our authorization acquired the vault", async () => {
      const { funding, getLogs, authorizationId } = await authorized({
        swapLogs: [{ blockNumber: 99n }],
      });

      expect(await funding.spentWithoutUs(authorizationId)).toBe(true);
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
      const { funding, authorizationId } = await authorized({ swapLogs: [] });
      expect(await funding.spentWithoutUs(authorizationId)).toBe(false);
    });

    // Nothing was ever signed for this vault, so no batch of ours can exist to have been executed —
    // and a log search would be answering a question about someone else's acquisition.
    // Nothing signed means no batch of ours can be waiting to execute, and a log search would be
    // answering a question about someone else's acquisition.
    it("reports no spend for an authorization it never issued", async () => {
      const { funding, getLogs } = build({ swapLogs: [{ blockNumber: 99n }] });
      await funding.prepare();

      expect(await funding.spentWithoutUs(undefined)).toBe(false);
      expect(await funding.spentWithoutUs(`0x${"f".repeat(64)}`)).toBe(false);
      expect(getLogs).not.toHaveBeenCalled();
    });

    // Bounded by the block the authorization was signed at, not by converting the deadline into
    // blocks — that needs a block time we do not know, and guessing it too fast searches a window
    // narrower than the one the batch was live for.
    it("searches from the block the authorization was signed at, less the reorg margin", async () => {
      const { funding, getLogs, authorizationId } = await authorized({ blockNumber: 500n });
      await funding.spentWithoutUs(authorizationId);

      expect(getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 500n - 12n, toBlock: "latest" })
      );
    });

    // The margin is the whole point: starting exactly at the recorded height misses an execution
    // that landed a block or two earlier — a reorg, or a `getLogs` endpoint sitting behind the one
    // that answered `getBlock`. A miss here reports spent money as never spent, which releases its
    // reservation and lets the same balance be committed twice.
    it("still finds an execution that landed just below the recorded height", async () => {
      const { funding, authorizationId } = await authorized({
        blockNumber: 500n,
        swapLogs: [{ blockNumber: 497n }],
      });
      expect(await funding.spentWithoutUs(authorizationId)).toBe(true);
    });

    it("does not reach below block zero near the genesis end of the chain", async () => {
      const { funding, getLogs, authorizationId } = await authorized({
        blockNumber: 3n,
        headBlock: 3n,
      });
      await funding.spentWithoutUs(authorizationId);

      expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 0n }));
    });

    // A recorded height above the chain we can see is an anomaly, not a range: asking for it is
    // provider-dependent (some return nothing, some error), and "nothing" here reads as "our money
    // never moved". Clamp to the head, scan the recent window, and say so.
    it("clamps to the head when the recorded height is above it, and warns", async () => {
      const { funding, getLogs, logger, authorizationId } = await authorized({
        blockNumber: 900n,
        headBlock: 400n,
      });
      await funding.spentWithoutUs(authorizationId);

      expect(getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 400n - 12n, toBlock: "latest" })
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/above the chain head/));
    });
  });

  // The deadline is chain time by design, and that is right — but it is also the entire lifetime of
  // a bearer authorization anyone who sees it may execute, decided by one unvalidated RPC answer.
  // A signed batch outlives the transaction that was meant to carry it: `SelfCallRelayer` has no
  // nonce and no submitter binding, so until its deadline anyone who saw it may execute it. Once
  // the risk slot closes the gate stops reserving that WBTC, and this is the only thing left
  // counting it.
  describe("holding capacity for batches that are settled but still executable", () => {
    /** Sign a batch, then tell the mode what became of the slot that opened it. */
    async function authorizedThen(
      outcome: { consumed: boolean } | undefined,
      opts: Parameters<typeof build>[0] = {}
    ) {
      const h = build({ balance: 1_000n, allowance: 1_000n, ...opts });
      await h.funding.prepare();
      const { authorizationId } = await h.funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });
      if (outcome) h.funding.settleAuthorization(authorizationId, outcome);
      await h.funding.refreshInventory();
      return { ...h, authorizationId };
    }

    /** What the gate was told it may spend. */
    const published = (h: { recordFundingCapacity: ReturnType<typeof vi.fn> }) =>
      h.recordFundingCapacity.mock.calls.at(-1)?.[0];

    // While the slot is open the gate is already reserving `maxWbtcIn`. Subtracting here too would
    // deduct the same acquisition twice and halve what the treasury can actually fund.
    it("holds nothing while the slot that opened it is still open", async () => {
      const h = await authorizedThen(undefined);
      expect(published(h)).toMatchObject({ authorized: 0n });
    });

    it("holds the batch once its slot settles without proving the money moved", async () => {
      const h = await authorizedThen({ consumed: false });
      expect(published(h)).toMatchObject({ authorized: 90n });
    });

    // The confirmed acquisition's WBTC has already left, so the balance read reports it. Holding it
    // as well would subtract the same money twice and shrink capacity for no reason.
    it("holds nothing for a batch whose acquisition confirmed", async () => {
      const h = await authorizedThen({ consumed: true });
      expect(published(h)).toMatchObject({ authorized: 0n });
    });

    it("publishes capacity net of the hold, not the raw balance", async () => {
      const h = await authorizedThen({ consumed: false }, { balance: 1_000n, allowance: 1_000n });
      // 1_000 held by the treasury, 90 of it spoken for by a batch anyone may still submit.
      expect(h.risk.openSlot({ kind: "a", subject: "v", spend: [SPEND(911n)] }).allowed).toBe(
        false
      );
      expect(h.risk.openSlot({ kind: "a", subject: "v", spend: [SPEND(910n)] }).allowed).toBe(true);
    });

    // A duplicate intent re-signs the same vault every cycle under a fresh deadline, so a fresh
    // digest. Summing those would let one vault stack holds against itself until they expired —
    // starving the treasury for a vault that can only ever be bought once.
    it("holds one acquisition's worth for a vault re-signed many times, not the sum", async () => {
      const h = build({ balance: 1_000n, allowance: 1_000n });
      await h.funding.prepare();
      for (const [i, amount] of [90n, 80n, 70n].entries()) {
        // A later block each time, so each build produces a distinct digest as a real cycle would.
        h.getBlock.mockResolvedValue({
          timestamp: 1_700_000_000n + BigInt(i),
          number: 100n + BigInt(i),
        });
        const { authorizationId } = await h.funding.buildAcquisition({
          vaultId: VAULT_ID,
          preview: PREVIEW,
          maxWbtcIn: amount,
        });
        h.funding.settleAuthorization(authorizationId, { consumed: false });
      }
      h.getBlock.mockResolvedValue({ timestamp: 1_700_000_002n, number: 102n });
      await h.funding.refreshInventory();

      // The worst single outcome, not 90 + 80 + 70.
      expect(published(h)).toMatchObject({ authorized: 90n });
    });

    // Past its deadline the router refuses the batch, so it can take nothing and must stop being
    // held — otherwise every abandoned acquisition would shrink the treasury permanently.
    it("releases the hold once the batch expires", async () => {
      const h = build({ balance: 1_000n, allowance: 1_000n });
      await h.funding.prepare();
      const { authorizationId } = await h.funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });
      h.funding.settleAuthorization(authorizationId, { consumed: false });

      // Past the 120s deadline signed at 1_700_000_000, and past the margin held on top of it.
      h.getBlock.mockResolvedValue({ timestamp: 1_700_000_150n, number: 200n });
      await h.funding.refreshInventory();
      expect(published(h)).toMatchObject({ authorized: 0n });
    });

    // Expiry is judged from one header, and a header is not the canonical chain: a shallow reorg or
    // a pool member a block behind can put the batch back inside its window after this map has
    // dropped it — and an authorization nobody accounts for is treasury capacity committed twice.
    it("keeps holding through the first header that reports expiry", async () => {
      const h = build({ balance: 1_000n, allowance: 1_000n });
      await h.funding.prepare();
      const { authorizationId } = await h.funding.buildAcquisition({
        vaultId: VAULT_ID,
        preview: PREVIEW,
        maxWbtcIn: 90n,
      });
      h.funding.settleAuthorization(authorizationId, { consumed: false });

      // One second past the deadline: expired by this header, and a block or two of disagreement
      // away from not being.
      h.getBlock.mockResolvedValue({ timestamp: 1_700_000_121n, number: 200n });
      await h.funding.refreshInventory();

      expect(published(h)).toMatchObject({ authorized: 90n });
    });

    // The other way out: someone submitted it. The vault leaves escrow, so no batch for it can
    // execute again — and the balance read at this same block already reports the payment.
    it("releases the hold once the router shows the vault acquired", async () => {
      const h = await authorizedThen(
        { consumed: false },
        { swapLogs: [{ blockNumber: 99n, args: { vaultId: VAULT_ID } }] }
      );
      expect(published(h)).toMatchObject({ authorized: 0n });
    });

    // The reads have to describe one chain. A balance from before the execution and a log from
    // after it would retire the hold *and* report the money as still there — the same WBTC
    // spendable twice, which is the error the hold exists to prevent.
    it("pins the balance, the allowance and the log scan to one block", async () => {
      const h = await authorizedThen({ consumed: false });
      const at = (call: unknown[]) => (call[0] as { blockNumber?: bigint }).blockNumber;
      const reads = h.readContract.mock.calls.filter(
        (c: unknown[]) => (c[0] as { functionName: string }).functionName !== "signer"
      );
      const balanceReads = reads.filter(
        (c: unknown[]) => (c[0] as { functionName: string }).functionName === "balanceOf"
      );
      expect(at(balanceReads.at(-1) as unknown[])).toBe(100n);
      expect(h.getLogs.mock.calls.at(-1)?.[0]).toMatchObject({ toBlock: 100n });
    });
  });

  describe("refusing to sign against implausible block metadata", () => {
    const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

    it("signs normally when the block's timestamp tracks this host's clock", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: nowSeconds() });
      await funding.prepare();
      await funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });

      expect(signTypedData).toHaveBeenCalled();
    });

    it("tolerates a lead within the allowance, since chain time is not our clock", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: nowSeconds() + 59n });
      await funding.prepare();
      await funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });

      expect(signTypedData).toHaveBeenCalled();
    });

    // The bound itself, not just a value under it: a lead this size is minutes of chain time out of
    // step with the host, which is not skew — and every second of it would be added to the window.
    it("refuses a lead of minutes, however plausible the block otherwise looks", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: nowSeconds() + 299n });

      await funding.prepare();
      await expect(
        funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n })
      ).rejects.toThrow(/leads this host's clock/);
      expect(signTypedData).not.toHaveBeenCalled();
    });

    // Whatever lead is tolerated is added to the configured window, because the deadline is that
    // timestamp plus `deadlineSeconds`. The bound therefore decides the worst-case lifetime of a
    // bearer signature, and it has to stay a fraction of the window rather than a multiple of it.
    it("bounds the lifetime a tolerated lead can buy", async () => {
      const now = nowSeconds();
      const { funding, signTypedData } = build({ blockTimestamp: now + 59n });
      await funding.prepare();
      await funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });

      const { message } = signTypedData.mock.calls[0][0] as { message: { deadline: bigint } };
      // 120s configured; the lead may stretch it, but not past half as long again.
      expect(message.deadline - now).toBeLessThanOrEqual(120n + 60n);
    });

    // A month-ahead timestamp turns a 120-second authorization into a month-long one. The router
    // carries no nonce, so that deadline is the only thing standing between the signature and
    // whoever saw it during gas estimation.
    it("refuses to sign against a timestamp far ahead of this host's clock", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: nowSeconds() + 30n * 86_400n });
      await funding.prepare();

      await expect(
        funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n })
      ).rejects.toThrow(/leads this host's clock/);
      expect(signTypedData).not.toHaveBeenCalled();
    });

    // And it leaves no trace: nothing was signed, so no authorization exists to go looking for.
    it("records no authorization for a refused signature", async () => {
      const { funding, getLogs } = build({ blockTimestamp: nowSeconds() + 30n * 86_400n });
      await funding.prepare();
      await funding
        .buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n })
        .catch(() => {});

      // Whatever id a caller might hold, no record exists for it.
      expect(await funding.spentWithoutUs(undefined)).toBe(false);
      expect(getLogs).not.toHaveBeenCalled();
    });

    // A stale replica is the ordinary case and must keep working: an old block shortens the window
    // rather than inflating it, which is safe.
    it("signs against a block whose timestamp trails this host's clock", async () => {
      const { funding, signTypedData } = build({ blockTimestamp: nowSeconds() - 86_400n });
      await funding.prepare();
      await funding.buildAcquisition({ vaultId: VAULT_ID, preview: PREVIEW, maxWbtcIn: 90n });

      expect(signTypedData).toHaveBeenCalled();
    });
  });
});
