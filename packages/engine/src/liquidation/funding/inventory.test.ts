import { type RiskGate, createRiskGate } from "@repo/risk";
import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { SpokeReserve, SpokeReserves } from "../reserves";
import type { LiquidatablePosition } from "../types";
import { InventoryFunding } from "./inventory";
import type { LiquidationCandidate } from "./types";

const SIGNER = "0xsigner" as Address;
const ADAPTER = "0xadapter" as Address;
const WBTC = "0xwbtc" as Address;
const USDC = "0xusdc" as Address;
const USDT = "0xusdt" as Address;
const VAULT_BTC = "0xvaultbtc" as Address;

const position = {
  proxyAddress: "0xproxy",
  borrower: "0xborrower",
} as unknown as LiquidatablePosition;
/** A candidate from `(reserve id, debt to cover)` pairs — the shape the preview answers in. */
const VAULT = `0x${"11".repeat(32)}` as const;
const candidate = (debt: Array<[bigint, bigint]>, wbtcPayment = 0n): LiquidationCandidate => ({
  position,
  debtReserveIds: debt.map(([id]) => id),
  debtToCoverAmounts: debt.map(([, amount]) => amount),
  wbtcPayment,
  vaultId: VAULT,
});

const reserve = (id: number, token: Address, borrowable = true): SpokeReserve => ({
  id,
  token,
  borrowable,
});

type Revoke = (input: { token: Address; spender: Address; label?: string }) => Promise<unknown>;

function build(reserves: SpokeReserve[], opts: { balance?: bigint; revoke?: Revoke } = {}) {
  const risk = createRiskGate();
  const topology: SpokeReserves = { spoke: "0xspoke" as Address, reserves };
  const revokeAllowance = vi.fn(opts.revoke ?? (async () => ({ kind: "satisfied" as const })));
  const readReserves = vi.fn(async () => topology);
  const funding = new InventoryFunding({
    publicClient: {
      getBlockNumber: vi.fn(async () => 1n),
      getTransactionReceipt: vi.fn(async () => {
        throw new Error("not found");
      }),
      readContract: vi.fn(async () => opts.balance ?? 1_000_000_000n),
      simulateContract: vi.fn(async () => ({ result: true })),
    } as unknown as PublicClient,
    risk,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { recordError: vi.fn(), recordSimulationFailed: vi.fn() },
    executor: {
      identity: { from: SIGNER, chainId: 31337 },
      ensureAllowance: vi.fn(async () => ({ kind: "satisfied" as const })),
      revokeAllowance,
      inFlightTxHashes: vi.fn(async () => undefined),
    },
    tokenMeta: { get: vi.fn(async () => ({ symbol: "TKN", decimals: 18 })) },
    reserves: readReserves,
    adapterAddress: ADAPTER,
    wbtcAddress: WBTC,
    btcRedeemKey: `0x${"0".repeat(64)}`,
    llpAddress: "0xllp",
    isDirectRedemption: false,
  } as unknown as ConstructorParameters<typeof InventoryFunding>[0]);
  return { funding, risk, revokeAllowance, readReserves };
}

/** What the gate ends up reserving per token, after vetting one candidate. */
async function reservedFor(
  funding: InventoryFunding,
  risk: RiskGate,
  input: LiquidationCandidate,
  tokens: Address[]
) {
  await funding.refreshInventory();
  const [vetted] = await funding.vet([input]);
  if (!vetted) return undefined;
  risk.openSlot({ kind: "liquidation", subject: "0xproxy", ...vetted.risk });
  return Object.fromEntries(tokens.map((t) => [t, risk.reserved({ owner: SIGNER, token: t })]));
}

describe("InventoryFunding spend attribution", () => {
  // The defect this exists for. Each amount is paired with a *reserve id*, and the adapter pulls it
  // in that reserve's underlying — not in the underlying of the reserve at the same position in the
  // borrowable list. Here VaultBTC is reserve 0, which shifts every borrowable token by one:
  // resolving the pairs against the borrowable subset charges USDC's debt to USDT's balance.
  it("charges each amount to the token of the reserve id it is paired with", async () => {
    const { funding, risk } = build([
      reserve(0, VAULT_BTC, false), // collateral, sorts FIRST
      reserve(1, USDC),
      reserve(2, USDT),
    ]);

    const reserved = await reservedFor(
      funding,
      risk,
      candidate([
        [1n, 500n],
        [2n, 700n],
      ]),
      [USDC, USDT, VAULT_BTC]
    );

    expect(reserved).toEqual({ [USDC]: 500n, [USDT]: 700n, [VAULT_BTC]: 0n });
  });

  it("declares nothing for the reserves the borrower owes nothing on", async () => {
    const { funding } = build([reserve(0, USDC), reserve(1, USDT)]);
    await funding.refreshInventory();

    const [vetted] = await funding.vet([
      candidate([
        [0n, 500n],
        [1n, 0n],
      ]),
    ]);

    // Absent, not zero. The gate checks that it knows a balance *before* it looks at the amount, so
    // a declared zero for a token whose balance was never published blocks the action outright —
    // which for a collateral-only reserve would be every liquidation this bot could otherwise fund.
    expect(vetted.risk.spend).toEqual([{ owner: SIGNER, token: USDC, amount: 500n }]);
  });

  it("sums the fairness payment onto a WBTC repayment rather than declaring half of it", async () => {
    const { funding, risk } = build([reserve(0, USDC), reserve(1, WBTC)]);

    const reserved = await reservedFor(
      funding,
      risk,
      candidate(
        [
          [0n, 100n],
          [1n, 300n],
        ],
        50n
      ),
      [USDC, WBTC]
    );

    expect(reserved).toEqual({ [USDC]: 100n, [WBTC]: 350n });
  });

  it("sums two reserves that share an underlying", async () => {
    const { funding, risk } = build([reserve(0, USDC), reserve(1, USDC)]);

    const reserved = await reservedFor(
      funding,
      risk,
      candidate([
        [0n, 100n],
        [1n, 200n],
      ]),
      [USDC]
    );

    expect(reserved).toEqual({ [USDC]: 300n });
  });

  // The pairing *is* the token mapping, so a length that disagrees leaves every pair past the
  // shorter array a guess — it cannot be papered over by zipping to the shorter of the two.
  it.each([
    ["short", [0n, 1n], [500n]],
    ["long", [0n], [500n, 600n]],
  ])(
    "refuses a %s amounts vector rather than attributing it",
    async (_label, debtReserveIds, debtToCoverAmounts) => {
      const { funding, risk } = build([reserve(0, USDC), reserve(1, USDT)]);
      await funding.refreshInventory();

      await expect(
        funding.vet([
          { position, debtReserveIds, debtToCoverAmounts, wbtcPayment: 0n, vaultId: VAULT },
        ])
      ).rejects.toThrow(/refusing to attribute/);
      expect(risk.reserved({ owner: SIGNER, token: USDC })).toBe(0n);
    }
  );

  // An id the Spoke does not list means the preview and the Spoke are not describing the same
  // deployment. There is no token to charge it to, and the whole point of resolving through the
  // reserve list is to never guess one.
  it("refuses a reserve id the Spoke does not list", async () => {
    const { funding, risk } = build([reserve(0, USDC), reserve(1, USDT)]);
    await funding.refreshInventory();

    await expect(funding.vet([candidate([[2n, 500n]])])).rejects.toThrow(/refusing to attribute/);
    expect(risk.reserved({ owner: SIGNER, token: USDC })).toBe(0n);
  });

  // A frozen reserve still carries the debt that was taken before it froze, and the flag does not
  // stop it being repaid: the adapter does a plain `transferFrom` and takes vaultBTC collateral.
  // So the amount is attributed to its token like any other, and what decides whether the action
  // goes ahead is whether the signer actually holds that token — which the gate already knows.
  describe("a reserve that is no longer borrowable", () => {
    it("is still charged to its own token", async () => {
      const { funding } = build([reserve(0, USDC), reserve(1, USDT, false)]);
      await funding.refreshInventory();

      const [vetted] = await funding.vet([
        candidate([
          [0n, 100n],
          [1n, 900n],
        ]),
      ]);

      expect(vetted.risk.spend).toEqual([
        { owner: SIGNER, token: USDC, amount: 100n },
        { owner: SIGNER, token: USDT, amount: 900n },
      ]);
    });

    // Nothing published a balance for USDT, so the gate refuses the action by itself, naming the
    // token. No separate error path is needed to reach that answer.
    it("is blocked by the gate when the signer does not hold that token", async () => {
      const { funding, risk } = build([reserve(0, USDC), reserve(1, USDT, false)]);
      await funding.refreshInventory();
      const [vetted] = await funding.vet([
        candidate([
          [0n, 100n],
          [1n, 900n],
        ]),
      ]);

      const slot = risk.openSlot({ kind: "liquidation", subject: "0xproxy", ...vetted.risk });

      expect(slot.allowed).toBe(false);
      expect(slot.reason).toContain(USDT);
    });

    // And when the token IS one we hold — another reserve lists it, or it is WBTC — the
    // liquidation is fundable and proceeds. Refusing it on the flag alone would have thrown away
    // a valid liquidation.
    it("is fundable when another reserve lists the same token", async () => {
      const { funding, risk } = build([reserve(0, USDC), reserve(1, USDC, false)]);

      const reserved = await reservedFor(
        funding,
        risk,
        candidate([
          [0n, 100n],
          [1n, 900n],
        ]),
        [USDC]
      );

      expect(reserved).toEqual({ [USDC]: 1000n });
    });
  });

  it("refuses to vet before the Spoke has been read", async () => {
    const { funding } = build([reserve(0, USDC)]);

    await expect(funding.vet([candidate([[0n, 100n]])])).rejects.toThrow(/before refreshInventory/);
  });
});

// The gate halting stops what this bot sends. It does nothing about the adapter, which needs
// nothing further from us to pull what it was already approved for — so a code-hash halt takes
// that back, and the engine's halted cycle is what calls this.
describe("InventoryFunding revokeApprovals", () => {
  const revoked = (calls: { token: Address; spender: Address }[]) =>
    calls.map((c) => [c.token, c.spender]);

  it("withdraws the adapter's allowance on every token it approves", async () => {
    const { funding, revokeAllowance, readReserves } = build([
      reserve(0, USDC),
      reserve(1, VAULT_BTC, false),
      reserve(2, USDT),
    ]);

    await funding.revokeApprovals();

    // Exactly the set `refreshInventory` approves: the borrowable reserves plus WBTC, and nothing
    // for a reserve nothing can be borrowed from.
    expect(revoked(revokeAllowance.mock.calls.map((c) => c[0]))).toEqual([
      [USDC, ADAPTER],
      [USDT, ADAPTER],
      [WBTC, ADAPTER],
    ]);
    // No cycle has run, so the list came from a fresh read — a bot that halted at boot has no
    // published topology to withdraw against.
    expect(readReserves).toHaveBeenCalled();
  });

  it("withdraws the rest when one token cannot be", async () => {
    const { funding, revokeAllowance } = build([reserve(0, USDC), reserve(1, USDT)], {
      revoke: async ({ token }) => {
        if (token === USDC) throw new Error("rpc down");
        return { kind: "satisfied" as const };
      },
    });

    await expect(funding.revokeApprovals()).resolves.toBeUndefined();

    // The next token is a different allowance and a different transaction: one failure is no
    // reason to leave the others standing.
    expect(revokeAllowance.mock.calls.map((c) => c[0].token)).toEqual([USDC, USDT, WBTC]);
  });
});
