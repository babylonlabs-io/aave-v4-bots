import { createRiskGate } from "@repo/risk";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../../shared/executor";
import { InventoryFunding } from "./inventory";
import type { FundingContext } from "./types";

const SIGNER = "0xsigner0000000000000000000000000000000001" as const;
const WBTC = "0xwbtc00000000000000000000000000000000000a" as const;
const VAULT_SWAP = "0xvaultswap000000000000000000000000000000b" as const;
const KEEPER = "0xkeeper00000000000000000000000000000000c1" as const;
const VAULT_ID = "0xvault" as `0x${string}`;

function build(overrides: Partial<FundingContext> = {}) {
  const ensureAllowance = vi.fn().mockResolvedValue({ kind: "satisfied" });
  const risk = createRiskGate();
  const context = {
    publicClient: {
      readContract: vi.fn().mockResolvedValue(500n),
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      // Nothing has mined in this fixture: an outflow is held until something says otherwise.
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("not found")),
    } as unknown as FundingContext["publicClient"],
    risk,
    metrics: { recordFundingCapacity: vi.fn() },
    executor: {
      identity: { from: SIGNER, chainId: 31337 },
      ensureAllowance,
      // Conservative default: this fixture keeps no store, so it cannot say whether a broadcast
      // transaction is still in flight — and an unanswered question must not retire a hold.
      inFlightTxHashes: vi.fn(async () => undefined),
    } as unknown as Executor,
    wbtcAddress: WBTC,
    vaultSwapAddress: VAULT_SWAP,
    ...overrides,
  };
  return { funding: new InventoryFunding(context), risk, ensureAllowance, context };
}

describe("InventoryFunding", () => {
  it("spends the signer's own WBTC", () => {
    expect(build().funding.spend(42n)).toEqual({ owner: SIGNER, token: WBTC, amount: 42n });
  });

  // The regression. An acquisition whose receipt never arrived is still owed by this balance, and
  // the next read cannot report it precisely because the transaction has not mined — so a refresh
  // must not hand the same WBTC out again. In the arbitrageur the second spender is the liquidation
  // engine, against the very same signer.
  describe("an unresolved acquisition's WBTC", () => {
    const TX = "0xtx" as const;
    const acquiring = (amount: bigint) => ({
      kind: "vault-acquisition",
      subject: VAULT_ID,
      spend: [{ owner: SIGNER, token: WBTC, amount }],
    });

    /** Balance 500, an acquisition of 400 broadcast and never resolved. */
    const pending = (inFlight: readonly string[]) => {
      const inFlightTxHashes = vi.fn(async () => new Set(inFlight));
      const built = build({
        executor: {
          identity: { from: SIGNER, chainId: 31337 },
          ensureAllowance: vi.fn().mockResolvedValue({ kind: "satisfied" }),
          inFlightTxHashes,
        } as unknown as Executor,
      });
      built.risk.setAvailable({ owner: SIGNER, token: WBTC }, 500n, 1n);
      built.risk.openSlot(acquiring(400n)).settle({ ok: false, unresolved: true, txHash: TX });
      return { ...built, inFlightTxHashes };
    };

    it("survives a refresh that reads the balance it has not left yet", async () => {
      const { funding, risk } = pending([TX]);

      await funding.refreshInventory(); // the mock still reports the full 500

      expect(risk.openSlot(acquiring(400n)).allowed).toBe(false);
      expect(risk.openSlot(acquiring(100n)).allowed).toBe(true);
    });

    it("is released once the chain has moved past the transaction", async () => {
      const { funding, risk, inFlightTxHashes } = pending([]);

      await funding.refreshInventory();

      expect(inFlightTxHashes).toHaveBeenCalled();
      expect(risk.openSlot(acquiring(500n)).allowed).toBe(true);
    });
  });

  it("publishes the signer's WBTC under its own ledger entry", async () => {
    const { funding, risk } = build();

    await funding.refreshInventory();

    // Published under `(signer, WBTC)`, so a slot naming that account can be admitted...
    const slot = risk.openSlot({
      kind: "vault-acquisition",
      subject: VAULT_ID,
      spend: [{ owner: SIGNER, token: WBTC, amount: 500n }],
    });
    expect(slot.allowed).toBe(true);

    // ...while the same token held by anyone else remains unknown, and so fails closed.
    expect(
      risk.openSlot({
        kind: "vault-acquisition",
        subject: VAULT_ID,
        spend: [{ owner: "0xtreasury", token: WBTC, amount: 1n }],
      }).allowed
    ).toBe(false);
  });

  it("asks the executor to approve the LLP for the worst-case spend", async () => {
    const { funding, ensureAllowance } = build();

    await funding.ensureFunded(1_234n);

    expect(ensureAllowance).toHaveBeenCalledWith({
      token: WBTC,
      spender: VAULT_SWAP,
      required: 1_234n,
      label: "WBTC",
    });
  });

  it("pays for itself when no keeper is configured", async () => {
    const { call } = await build().funding.buildAcquisition({
      vaultId: VAULT_ID,
      maxWbtcIn: 99n,
    });

    // No keeper ⇒ the signer must itself be a registered one, and the vault redeems to its BTC key.
    expect(call.functionName).toBe("swapWbtcForVault");
    expect(call.args).toEqual([VAULT_ID, 99n]);
  });

  it("redeems to the configured keeper when one is set", async () => {
    const { call } = await build({ vaultKeeperAddress: KEEPER }).funding.buildAcquisition({
      vaultId: VAULT_ID,
      maxWbtcIn: 99n,
    });

    expect(call.functionName).toBe("swapWbtcForVaultOnBehalf");
    expect(call.args).toEqual([VAULT_ID, 99n, KEEPER]);
  });
});
