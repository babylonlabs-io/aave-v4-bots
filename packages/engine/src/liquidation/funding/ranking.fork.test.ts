import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aaveV3PoolAbi,
  encodePoolKey,
  erc20Abi,
  liquidationRouterAbi,
  v4QuoterAbi,
} from "@repo/abis";
import { createRiskGate } from "@repo/risk";
import {
  http,
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpokeReserves } from "../reserves";
import { FlashFunding, type FlashFundingDeps } from "./flash";
import { createAaveV3Source, percentMulCeil } from "./flashVenues/aaveV3";
import type { LiquidationCandidate } from "./types";
import { createReadCache } from "./venueRoutes/cache";
import { parseFlashVenues } from "./venueRoutes/factory";

// The ranked route against real Ethereum mainnet state: real Morpho, Aave v3, V4Quoter and StateView, and two real
// WBTC/USDC UniswapV4 pools of similar depth and different fees. Everything from quoting to the `flashDatas` the
// router would receive is the production code; only the router's probe is answered here, because no router is
// deployed on mainnet to answer it. `test/fork/VenueQuoteParityTest.t.sol` executes the same swaps at the same
// block and holds the quotes this ranks by to what the venue charges.
//
// Runs only when ETHEREUM_FORK_RPC_URL names an archive endpoint. It then needs `anvil` on the PATH and
// `forge build` output, and fails without them rather than skipping, so a run that asked for it cannot pass empty.

const RPC = process.env.ETHEREUM_FORK_RPC_URL;

/** The block `test/fork/base/TestSuites.sol` pins as `MAINNET_FORK_BLOCK`. */
const FORK_BLOCK = 25_982_687;

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as Address;
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address;
const QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as Address;
const STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as Address;
/** An address holding no WBTC at the pinned block, standing in for the router the probe would call. */
const ROUTER = "0x00000000000000000000000000000000000fa11e" as Address;
/** Anvil's first default account: a public, well-known test key that only ever signs on the local fork. */
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const tightPool = { currency0: WBTC, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO };
const widePool = { currency0: WBTC, currency1: USDC, fee: 3000, tickSpacing: 60, hooks: ZERO };

const ARTIFACT = join(
  dirname(fileURLToPath(import.meta.url)),
  ...Array(5).fill(".."),
  "out",
  "UniswapV4SwapVenue.sol",
  "UniswapV4SwapVenue.json"
);

const TOPOLOGY: SpokeReserves = {
  spoke: ZERO,
  reserves: [
    { id: 0, token: USDC, borrowable: true, repayable: true },
    { id: 1, token: WBTC, borrowable: true, repayable: true },
  ],
};

/** Owes `usdc` of USDC and a 0.01 WBTC fairness payment. */
const candidate = (usdc: bigint) =>
  ({
    position: { borrower: ROUTER, proxyAddress: ROUTER },
    debtReserveIds: [0n],
    debtToCoverAmounts: [usdc],
    vaultId: `0x${"0".repeat(64)}`,
    wbtcPayment: 1_000_000n,
  }) as unknown as LiquidationCandidate;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject()
      );
    });
  });
}

describe.skipIf(RPC === undefined || RPC.length === 0)(
  "venue ranking on an Ethereum mainnet fork",
  { timeout: 180_000 },
  () => {
    let anvil: ChildProcess | undefined;
    let publicClient: PublicClient;
    let venue: Address;

    beforeAll(async () => {
      if (!existsSync(ARTIFACT)) {
        throw new Error(`no ${ARTIFACT}; run \`forge build\` first`);
      }
      const port = await freePort();
      anvil = spawn(
        "anvil",
        [
          "--fork-url",
          RPC as string,
          "--fork-block-number",
          String(FORK_BLOCK),
          "--port",
          String(port),
          "--silent",
        ],
        { stdio: "ignore" }
      );
      const spawnFailed = new Promise<never>((_, reject) =>
        anvil?.once("error", (error) =>
          reject(new Error(`could not start anvil: ${error.message}`))
        )
      );

      const url = `http://127.0.0.1:${port}`;
      // A cold fork fetches every storage slot a quote touches from the upstream RPC, one by one, which
      // takes far longer than viem's default 10s. A timeout there reads as a failed quote, and the route
      // would quietly degrade instead of ranking.
      const transport = http(url, { timeout: 120_000 });
      publicClient = createPublicClient({ chain: mainnet, transport }) as PublicClient;
      const ready = (async () => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if ((await publicClient.getBlockNumber()) === BigInt(FORK_BLOCK)) return;
          } catch {
            // not listening yet
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("anvil did not serve the pinned block within 60s");
      })();
      await Promise.race([ready, spawnFailed]);

      const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
        abi: Abi;
        bytecode: { object: Hex };
      };
      const account = privateKeyToAccount(DEPLOYER_KEY);
      const wallet = createWalletClient({ account, chain: mainnet, transport });
      // Bound to the deployer as its venue manager: the route only reads the venue, never calls it.
      const hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [POOL_MANAGER, account.address],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("venue deployment produced no contract");
      venue = getAddress(receipt.contractAddress);
    });

    afterAll(async () => {
      if (anvil === undefined || anvil.exitCode !== null) return;
      const exited = new Promise((resolve) => anvil?.once("exit", resolve));
      anvil.kill("SIGTERM");
      await exited;
    });

    function flashFunding() {
      // The router's probe, answered: every route it is asked about realises plenty and owes nothing, so the
      // funded call carries exactly the route ranking built. Every other read goes to the fork.
      const probes: {
        flashDatas: readonly { token: Address; venueAddress: Address; swapData: Hex }[];
      }[] = [];
      const client = {
        ...publicClient,
        simulateContract: async (args: Parameters<PublicClient["simulateContract"]>[0]) => {
          if (args.functionName !== "liquidate") return publicClient.simulateContract(args);
          probes.push({ flashDatas: (args.args as readonly unknown[])[1] as never });
          throw new BaseError("execution reverted", {
            cause: new ContractFunctionRevertedError({
              abi: liquidationRouterAbi as unknown as never,
              data: encodeErrorResult({
                abi: liquidationRouterAbi,
                errorName: "BelovedError",
                args: [10n ** 8n, []],
              }),
              functionName: "liquidate",
            }),
          });
        },
      } as unknown as PublicClient;

      const metrics = { recordError: vi.fn(), recordSimulationFailed: vi.fn() };
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      // The wide pool is listed first, so choosing the tight one is ranking at work, not configuration order.
      const entries = parseFlashVenues(
        [
          `aavev3:${AAVE_POOL}`,
          `morpho:${MORPHO}`,
          `univ4:${venue}:${USDC}:${WBTC}:${USDC}:3000:60`,
          `univ4:${venue}:${USDC}:${WBTC}:${USDC}:500:10`,
        ].join(",")
      );
      const deps: FlashFundingDeps = {
        publicClient: client,
        wbtcAddress: WBTC,
        executor: {
          identity: { from: ROUTER, chainId: 1 },
        } as unknown as FlashFundingDeps["executor"],
        logger: logger as unknown as FlashFundingDeps["logger"],
        metrics,
        risk: createRiskGate(),
        reserves: async () => TOPOLOGY,
        routerAddress: ROUTER,
        maxSlippageBps: 2_000,
        ranking: { entries, quoter: QUOTER, stateView: STATE_VIEW },
      };
      return { funding: new FlashFunding(deps), probes, metrics, logger };
    }

    const quoteUsdc = async (pool: typeof tightPool, amount: bigint) => {
      const { result } = await publicClient.simulateContract({
        address: QUOTER,
        abi: v4QuoterAbi,
        functionName: "quoteExactOutputSingle",
        args: [{ poolKey: pool, zeroForOne: true, exactAmount: amount, hookData: "0x" }],
      });
      return result[0];
    };

    it("passes the boot checks against the real venues", async () => {
      // Quoter, StateView and the swap venue share one pool manager; the Aave pool lists WBTC.
      await expect(flashFunding().funding.prepare()).resolves.toBeUndefined();
    });

    it("routes USDC through the cheaper of two real pools, and WBTC through Morpho", async () => {
      const size = 50_000_000_000n; // 50,000 USDC
      const [tight, wide] = [await quoteUsdc(tightPool, size), await quoteUsdc(widePool, size)];
      // At the pinned block the two pools price the same size apart, so ranking has a real choice.
      expect(tight).toBeLessThan(wide);

      const { funding, probes, metrics, logger } = flashFunding();
      const funded = await funding.vet([candidate(size)]);

      // First, so a skipped cycle or a degraded route names its reason instead of failing on the count.
      expect(vi.mocked(logger.error).mock.calls).toEqual([]);
      expect(vi.mocked(logger.warn).mock.calls).toEqual([]);
      expect(metrics.recordError).not.toHaveBeenCalled();
      expect(funded).toHaveLength(1);
      const [route] = probes.map((p) => p.flashDatas);
      expect(route.map((f) => f.token)).toEqual([USDC, WBTC]);
      expect(route[0]).toMatchObject({ venueAddress: venue, swapData: encodePoolKey(tightPool) });
      // Morpho lends free; Aave charges its premium, so it loses despite being listed first.
      expect(route[1].venueAddress).toBe(MORPHO);
      expect(funded[0].call.args?.[1]).toEqual(route);
    });

    it("skips a candidate no real pool can fill, before probing it", async () => {
      const { funding, probes, metrics, logger } = flashFunding();

      // Both pools must answer "cannot fill". A failed quote would degrade the route instead, and the
      // candidate would be probed rather than skipped.
      const funded = await funding.vet([candidate(10n ** 15n)]);
      expect(vi.mocked(logger.error).mock.calls).toEqual([]);
      expect(metrics.recordError).not.toHaveBeenCalled();
      expect(funded).toEqual([]);
      expect(probes).toHaveLength(0);
      expect(metrics.recordSimulationFailed).toHaveBeenCalledTimes(1);
      const [message] = vi.mocked(logger.warn).mock.calls[0] as [string];
      expect(message).toMatch(/no venue can fund it/);
      expect(message.match(/NotEnoughLiquidity/g)).toHaveLength(2);
    });

    it("prices Aave v3 as the pool charges and bounds it as the pool checks", async () => {
      const cache = createReadCache();
      const source = createAaveV3Source({ pool: AAVE_POOL }, 0, {
        publicClient,
        wbtc: WBTC,
        cache: () => cache,
      });
      const [premium, virtualBalance, reserve] = await Promise.all([
        publicClient.readContract({
          address: AAVE_POOL,
          abi: aaveV3PoolAbi,
          functionName: "FLASHLOAN_PREMIUM_TOTAL",
        }),
        publicClient.readContract({
          address: AAVE_POOL,
          abi: aaveV3PoolAbi,
          functionName: "getVirtualUnderlyingBalance",
          args: [WBTC],
        }),
        publicClient.readContract({
          address: AAVE_POOL,
          abi: aaveV3PoolAbi,
          functionName: "getReserveData",
          args: [WBTC],
        }),
      ]);
      const supply = await publicClient.readContract({
        address: reserve.aTokenAddress,
        abi: erc20Abi,
        functionName: "totalSupply",
      });

      // 1 WBTC plus a sat, so the premium has a remainder to round.
      const amount = 100_000_001n;
      await expect(source.quote(WBTC, amount)).resolves.toEqual({
        available: true,
        repayWbtc: amount + percentMulCeil(amount, premium),
        costBps: premium,
        liquidity: virtualBalance < supply ? virtualBalance : supply,
      });
    });
  }
);
