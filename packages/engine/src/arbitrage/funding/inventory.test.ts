import { erc20Abi, vaultSwapAbi } from "@repo/abis";
import {
  type ContractCall,
  MULTI_SEND_CALL_ONLY,
  MULTI_SEND_CALL_ONLY_CODE_HASH,
  buildMultiSendCall,
} from "@repo/execution";
import { createRiskGate } from "@repo/risk";
import { type Hex, TransactionReceiptNotFoundError, keccak256 } from "viem";
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
      getTransactionReceipt: vi
        .fn()
        .mockRejectedValue(new TransactionReceiptNotFoundError({ hash: "0xtx" })),
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
    expect(call.functionName).toBe("swapExitBtcForVault");
    expect(call.args).toEqual([VAULT_ID, 99n]);
  });

  it("redeems to the configured keeper when one is set", async () => {
    const { call } = await build({ vaultKeeperAddress: KEEPER }).funding.buildAcquisition({
      vaultId: VAULT_ID,
      maxWbtcIn: 99n,
    });

    expect(call.functionName).toBe("swapExitBtcForVaultOnBehalf");
    expect(call.args).toEqual([VAULT_ID, 99n, KEEPER]);
  });

  // A MANUAL Safe signs one SafeTx per vault: approve the ceiling, buy, reset to zero.
  describe("a MANUAL Safe", () => {
    const SAFE = "0x5730F27a396C6BA75125B3FDaF98577A4C8CE3b9" as const;
    const REAL_WBTC = "0x549A9C66B3d310A0cb706B8Efacf46bb13Abf210" as const;
    const REAL_SWAP = "0xA5f877cEfEAA7534460f19d7fc8b76CdE820a92A" as const;
    const REAL_KEEPER = "0x209a705D8A3e64AABCe37Ee2334f52C72777Cc59" as const;
    const VAULT = `0x${"66".repeat(32)}` as Hex;
    // Ethereum mainnet runtime code of MultiSendCallOnly v1.5.0; its keccak is the pinned hash.
    const MULTI_SEND_CALL_ONLY_CODE =
      "0x60806040526004361061001e5760003560e01c80638d80ff0a14610023575b600080fd5b6100dc6004803603602081101561003957600080fd5b810190808035906020019064010000000081111561005657600080fd5b82018360208201111561006857600080fd5b8035906020019184600183028401116401000000008311171561008a57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f8201169050808301925050505050505091929192905050506100de565b005b805160205b8181101561016a578083015160f81c6001820184015160601c3081150281179050601583018501516035840186015160558501870160008560008114610130576001811461014057610145565b6000808585888a5af19150610145565b600080fd5b5080610157576040513d6000823e3d81fd5b82605501870196505050505050506100e3565b50505056fea26469706673582212201ad552da02f0e66afd7f2ad29a305f1d4c737610d3b9e7ce8c994444949e57d664736f6c63430007060033" as Hex;

    it("pins the fixture to the canonical code hash", () => {
      expect(keccak256(MULTI_SEND_CALL_ONLY_CODE)).toBe(MULTI_SEND_CALL_ONLY_CODE_HASH);
    });

    const safeBuild = (code: Hex) => {
      const ensureAllowance = vi.fn();
      const getCode = vi.fn(async () => code);
      const built = build({
        publicClient: { getCode } as unknown as FundingContext["publicClient"],
        executor: {
          mode: "MANUAL",
          executorKind: "safe",
          identity: { from: SAFE, chainId: 1 },
          ensureAllowance,
        } as unknown as Executor,
        wbtcAddress: REAL_WBTC,
        vaultSwapAddress: REAL_SWAP,
        vaultKeeperAddress: REAL_KEEPER,
      });
      return { ...built, ensureAllowance };
    };

    it("needs no separate approval", async () => {
      const { funding, ensureAllowance } = safeBuild("0x");
      expect(await funding.ensureFunded(1_234n)).toEqual({ kind: "satisfied" });
      expect(ensureAllowance).not.toHaveBeenCalled();
    });

    it("refuses to boot when the pinned address holds other code", async () => {
      await expect(safeBuild("0x6001").funding.prepare()).rejects.toThrow(
        /not Safe's MultiSendCallOnly/
      );
      await expect(safeBuild("0x").funding.prepare()).rejects.toThrow(/code hash none/);
    });

    it("reads the code once, at boot", async () => {
      const { funding, context } = safeBuild(MULTI_SEND_CALL_ONLY_CODE);
      const getCode = (context.publicClient as unknown as { getCode: ReturnType<typeof vi.fn> })
        .getCode;
      await funding.prepare();
      await funding.buildAcquisition({ vaultId: VAULT, maxWbtcIn: 1n });
      await funding.buildAcquisition({ vaultId: VAULT, maxWbtcIn: 2n });
      expect(getCode).toHaveBeenCalledTimes(1);
    });

    it("builds the exact three-call batch", async () => {
      const approve = (amount: bigint): ContractCall => ({
        address: REAL_WBTC,
        abi: erc20Abi,
        functionName: "approve",
        args: [REAL_SWAP, amount],
      });
      const swap: ContractCall = {
        address: REAL_SWAP,
        abi: vaultSwapAbi,
        functionName: "swapExitBtcForVaultOnBehalf",
        args: [VAULT, 98_981n, REAL_KEEPER],
      };
      const expected = buildMultiSendCall([approve(98_981n), swap, approve(0n)]);

      const { funding } = safeBuild(MULTI_SEND_CALL_ONLY_CODE);
      const built = await funding.buildAcquisition({ vaultId: VAULT, maxWbtcIn: 98_981n });

      expect(built.call.address).toBe(MULTI_SEND_CALL_ONLY);
      expect(built.call).toEqual(expected);
      // Estimated as sent to the Safe with MultiSendCallOnly's code there, as a DELEGATECALL runs.
      expect(built.estimate).toEqual({
        address: SAFE,
        stateOverride: [{ address: SAFE, code: MULTI_SEND_CALL_ONLY_CODE }],
      });
    });
  });
});
