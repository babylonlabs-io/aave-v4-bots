import type { ContractCall, NonceAllocator, TxSender } from "@repo/execution";
import type { Logger } from "@repo/logger";
import type { NotificationEvent, Notifier } from "@repo/notifications";
import {
  type IntentInput,
  type MemoryStateStore,
  createMemoryStateStore,
  idempotencyKey,
} from "@repo/persistence";
import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createCrashSafety } from "./crashSafety";
import { createAutoExecutor, createManualExecutor } from "./executor";

const OPERATOR = "0x0000000000000000000000000000000000000Fee" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const silentLogger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const CALL: ContractCall = {
  address: TARGET,
  abi: [{ type: "function", name: "act", inputs: [], outputs: [], stateMutability: "nonpayable" }],
  functionName: "act",
  args: [],
};
const claim = (subject: string): IntentInput => ({
  chainId: 31337,
  target: TARGET,
  action: "liquidation",
  subject,
});

// ── AUTO ────────────────────────────────────────────────────────────────────────────────

/** A `TxSender` that records nonce+hash via `onSigned` before "broadcasting", like the real one. */
function autoSender(over: { send?: TxSender["send"] } = {}): TxSender {
  return {
    identity: { from: "0xsigner" as Address, chainId: 31337 },
    send:
      over.send ??
      vi.fn(async (call, onSigned) => {
        await onSigned?.({ hash: "0xhash" as Hex, nonce: call.nonce ?? 0, serialized: "0xraw" });
        return "0xhash" as Hex;
      }),
  };
}

function autoPublicClient(over: Record<string, unknown> = {}) {
  return {
    getTransactionCount: vi.fn(async () => 5),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n })),
    ...over,
  } as unknown as PublicClient;
}

const autoWallet = {
  account: { address: "0xsigner" },
  chain: { id: 31337 },
  writeContract: vi.fn(async () => "0xapprovehash"),
} as unknown as Parameters<typeof createAutoExecutor>[0]["walletClient"];

/** Identity allocator — the reserved nonce is whatever we seed; enough for commit's send path. */
const allocator = (nonce = 7): NonceAllocator => ({
  withNonce: (send) => send(nonce),
  resync: vi.fn(async () => {}),
});

function autoExecutor(
  sender = autoSender(),
  store?: MemoryStateStore,
  publicClient = autoPublicClient()
) {
  const crash = createCrashSafety({
    store,
    nonces: allocator(),
    publicClient,
    signer: sender.identity.from,
    logger: silentLogger,
  });
  const exec = createAutoExecutor({
    crash,
    sender,
    publicClient,
    walletClient: autoWallet,
    txReceiptTimeoutMs: 1000,
    logger: silentLogger,
  });
  return { exec, crash };
}

describe("createAutoExecutor", () => {
  it("reports AUTO mode and the sender's identity", () => {
    const { exec } = autoExecutor();
    expect(exec.mode).toBe("AUTO");
    expect(exec.identity).toEqual({ from: "0xsigner", chainId: 31337 });
  });

  it("commit signs + broadcasts and records the intent submitted", async () => {
    const store = createMemoryStateStore();
    const { exec } = autoExecutor(autoSender(), store);

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "broadcast", hash: "0xhash" });
    const row = store.get(idempotencyKey(claim("p")));
    // The allocator (default seed 7) supplies the nonce, which the sender signs and records.
    expect(row).toMatchObject({ status: "submitted", txHash: "0xhash", nonce: 7 });
  });

  it("commit returns `duplicate` for a live subject, without sending", async () => {
    const store = createMemoryStateStore();
    const send = vi.fn();
    const { exec } = autoExecutor(autoSender({ send }), store);
    await store.recordIntent(claim("p")); // already live

    const out = await exec.commit(CALL, claim("p"));

    expect(out.kind).toBe("duplicate");
    expect(send).not.toHaveBeenCalled();
  });

  it("commit `aborted` distinguishes a broadcast failure from a pre-broadcast one", async () => {
    const store = createMemoryStateStore();
    // A plain error = the broadcast was attempted (ambiguous).
    const { exec } = autoExecutor(
      autoSender({ send: vi.fn().mockRejectedValue(new Error("rpc timeout")) }),
      store
    );
    const out = await exec.commit(CALL, claim("p"));
    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: true });
    // The intent stays live (submitted), never terminal — reconcile decides later.
    expect(store.get(idempotencyKey(claim("p")))?.status).toBe("submitted");
  });

  it("signs against the nonce the allocator reserves", async () => {
    const send = vi.fn(
      async (call: { nonce?: number }, onSigned?: (t: unknown) => Promise<void>) => {
        await onSigned?.({ hash: "0xhash", nonce: call.nonce ?? -1, serialized: "0xraw" });
        return "0xhash" as Hex;
      }
    );
    const sender = autoSender({ send: send as unknown as TxSender["send"] });
    const crash = createCrashSafety({
      nonces: allocator(42),
      publicClient: autoPublicClient(),
      signer: sender.identity.from,
      logger: silentLogger,
    });
    const exec = createAutoExecutor({
      crash,
      sender,
      publicClient: autoPublicClient(),
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
    });

    await exec.commit(CALL, claim("p"));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ nonce: 42 }), expect.any(Function));
  });

  describe("ensureAllowance", () => {
    const WBTC = "0x0000000000000000000000000000000000000abc" as Address;
    const SPENDER = "0x0000000000000000000000000000000000000def" as Address;
    const allowanceReader = (allowance: bigint) => ({
      readContract: vi.fn(async () => allowance),
    });

    it("is `satisfied` without approving when allowance already covers the requirement", async () => {
      const pc = autoPublicClient(allowanceReader(10n ** 30n));
      const { exec } = autoExecutor(autoSender(), undefined, pc);

      const result = await exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n });

      expect(result).toEqual({ kind: "satisfied" });
      expect(autoWallet.writeContract).not.toHaveBeenCalled();
    });

    it("approves + waits the receipt when allowance is short (AUTO broadcasts a real approval)", async () => {
      const pc = autoPublicClient(allowanceReader(0n));
      (autoWallet.writeContract as ReturnType<typeof vi.fn>).mockClear();
      const { exec } = autoExecutor(autoSender(), undefined, pc);

      const result = await exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n });

      expect(result).toEqual({ kind: "satisfied" });
      expect(autoWallet.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "approve", args: [SPENDER, expect.anything()] })
      );
      expect(pc.waitForTransactionReceipt).toHaveBeenCalled();
    });

    it("throws when the approval reverts (as the engine's boot approval always did)", async () => {
      const pc = autoPublicClient({
        ...allowanceReader(0n),
        waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" })),
      });
      const { exec } = autoExecutor(autoSender(), undefined, pc);

      await expect(
        exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n })
      ).rejects.toThrow(/reverted/);
    });
  });
});

// ── MANUAL ──────────────────────────────────────────────────────────────────────────────

function fakeNotifier() {
  const events: NotificationEvent[] = [];
  const notifier: Notifier = { notify: async (e) => void events.push(e) };
  return { notifier, events };
}

const manualPublicClient = (over: Record<string, unknown> = {}) =>
  ({
    getTransaction: vi.fn(async () => ({ hash: "0xhash" })),
    getTransactionReceipt: vi.fn(),
    readContract: vi.fn(async () => 0n), // allowance, for ensureAllowance
    ...over,
  }) as unknown as PublicClient;

function manualExecutor(
  store: MemoryStateStore,
  notifier: Notifier,
  publicClient = manualPublicClient()
) {
  return createManualExecutor({
    store,
    publicClient,
    notifier,
    identity: { from: OPERATOR, chainId: 31337 },
    logger: silentLogger,
  });
}

describe("createManualExecutor (keyless)", () => {
  it("reports MANUAL mode + the operator identity, and exposes NO nonce API (keyless)", () => {
    const exec = manualExecutor(createMemoryStateStore(), fakeNotifier().notifier);
    expect(exec.mode).toBe("MANUAL");
    expect(exec.identity.from).toBe(OPERATOR);
    // The discriminated union makes it uncallable at the type level; assert it at runtime too — a
    // keyless bot must not carry `allocated`/`nextNonce` even to no-op them.
    expect("nextNonce" in exec).toBe(false);
    expect("allocated" in exec).toBe(false);
  });

  it("commit proposes a content-hashed intent and notifies — broadcasting nothing", async () => {
    const store = createMemoryStateStore();
    const { notifier, events } = fakeNotifier();
    const exec = manualExecutor(store, notifier);

    const out = await exec.commit(CALL, claim("p"));

    expect(out.kind).toBe("proposed");
    const row = store.get(idempotencyKey(claim("p")));
    expect(row).toMatchObject({ status: "proposed", nonce: null });
    expect(row?.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The notification carries the hash out-of-band (the operator's tamper check).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "manual-intent", payloadHash: row?.payloadHash });
  });

  it("dedups an unchanged re-proposal — one proposal, one notification", async () => {
    const store = createMemoryStateStore();
    const { notifier, events } = fakeNotifier();
    const exec = manualExecutor(store, notifier);

    await exec.commit(CALL, claim("p"));
    const second = await exec.commit(CALL, claim("p")); // same payload

    expect(second.kind).toBe("duplicate");
    expect(events).toHaveLength(1); // no re-notify storm
  });

  it("supersedes and re-proposes when the payload changed (the opportunity moved)", async () => {
    const store = createMemoryStateStore();
    const { notifier, events } = fakeNotifier();
    const exec = manualExecutor(store, notifier);

    await exec.commit(CALL, claim("p"));
    const firstHash = store.get(idempotencyKey(claim("p")))?.payloadHash;

    // A different call for the same subject ⇒ different payload hash ⇒ supersede + fresh proposal.
    const changed: ContractCall = { ...CALL, functionName: "act", args: [], abi: CALL.abi };
    // Force a distinct payload by changing the target address in the call.
    const out = await exec.commit(
      { ...changed, address: "0x00000000000000000000000000000000000000ff" as Address },
      claim("p")
    );

    expect(out.kind).toBe("proposed");
    const row = store.get(idempotencyKey(claim("p")));
    expect(row?.status).toBe("proposed");
    expect(row?.payloadHash).not.toBe(firstHash);
    expect(events).toHaveLength(2); // the fresh proposal re-notifies
  });

  describe("ensureAllowance (keyless)", () => {
    const TOKEN = "0x0000000000000000000000000000000000000abc" as Address;
    const SPENDER = "0x0000000000000000000000000000000000000def" as Address;

    it("is `satisfied` without proposing when allowance already covers the requirement", async () => {
      const store = createMemoryStateStore();
      const exec = manualExecutor(
        store,
        fakeNotifier().notifier,
        manualPublicClient({ readContract: vi.fn(async () => 10n ** 30n) })
      );

      const result = await exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 100n });

      expect(result).toEqual({ kind: "satisfied" });
      expect(store.all()).toHaveLength(0); // nothing proposed
    });

    it("proposes the approval (target=spender, subject=token) — broadcasting nothing", async () => {
      const store = createMemoryStateStore();
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(
        store,
        notifier,
        manualPublicClient({ readContract: vi.fn(async () => 0n) })
      );

      const result = await exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 100n });

      expect(result.kind).toBe("proposed");
      // Keyed by spender/token so two engines' approvals never collide (the #9a review point).
      const row = store.all()[0];
      expect(row).toMatchObject({
        action: "approval",
        target: SPENDER,
        subject: TOKEN,
        status: "proposed",
      });
      expect(events[0]).toMatchObject({ kind: "manual-intent", action: "approval" });
    });
  });
});
