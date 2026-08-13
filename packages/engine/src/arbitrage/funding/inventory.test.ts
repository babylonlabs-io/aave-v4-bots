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
    } as unknown as FundingContext["publicClient"],
    risk,
    metrics: { recordFundingCapacity: vi.fn() },
    executor: {
      identity: { from: SIGNER, chainId: 31337 },
      ensureAllowance,
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
