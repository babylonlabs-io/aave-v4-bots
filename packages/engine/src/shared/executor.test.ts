import {
  type ContractCall,
  type NonceAllocator,
  PreBroadcastError,
  type TxSender,
} from "@repo/execution";
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
import { createChainReader } from "./liveness";

import { createCrashSafety } from "./crashSafety";
import { createAutoExecutor, createAutoExecutorFromWallet, createManualExecutor } from "./executor";
import { createAutoExecutorWithSender } from "./executorTestKit";

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

/**
 * A store whose clock advances a second per write, so one attempt is distinguishable from the next.
 * In life they are at least a grace window apart — a row has to be resolved before it can be
 * revived — but a test does the whole sequence inside one millisecond, where `updatedAt` cannot
 * tell them apart and a guard bound to it would look like it works whether or not it does.
 */
function tickingStore() {
  let t = 1_700_000_000_000;
  return createMemoryStateStore(() => {
    t += 1_000;
    return t;
  });
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

/** Terse defaults over `./executorTestKit`, which owns the crash + sender construction. */
function autoExecutor(
  sender = autoSender(),
  store?: MemoryStateStore,
  publicClient = autoPublicClient()
) {
  return {
    exec: createAutoExecutorWithSender({
      sender,
      store,
      nonces: allocator(),
      publicClient,
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
    }),
  };
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
    // Faithful to `TxSender`'s contract: anything up to and including `onSigned` throws a
    // `PreBroadcastError`, so a *plain* error can only come from the broadcast itself — which means
    // the durable record already landed.
    const { exec } = autoExecutor(
      autoSender({
        send: vi.fn(async (call, onSigned) => {
          await onSigned?.({ hash: "0xhash" as Hex, nonce: call.nonce ?? 0, serialized: "0xraw" });
          throw new Error("rpc timeout");
        }),
      }),
      store
    );
    const out = await exec.commit(CALL, claim("p"));
    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: true });
    // The intent stays live (submitted), never terminal — reconcile decides later.
    expect(store.get(idempotencyKey(claim("p")))?.status).toBe("submitted");
  });

  // Ids identify a *subject*, not a try at it: a terminal row is revived in place for the next
  // attempt. Between claiming and signing — which spans an RPC `prepare` and a KMS round trip — the
  // other engine's reconcile can resolve this row and a later cycle can re-claim it. Broadcasting
  // then would put a transaction on chain whose nonce and hash are recorded against someone else's
  // attempt: invisible to the nonce fence, which only fences rows carrying both.
  describe("when the claimed attempt is resolved and revived mid-send", () => {
    /** Resolve and re-claim the row between the claim and `onSigned`, as another engine would. */
    const revivedDuringSend = (store: ReturnType<typeof createMemoryStateStore>) =>
      autoSender({
        send: vi.fn(async (call, onSigned) => {
          const id = idempotencyKey(claim("p"));
          await store.transition(id, "failed", { error: "reconciled while we were signing" });
          await store.recordIntent(claim("p"));
          try {
            await onSigned?.({
              hash: "0xhash" as Hex,
              nonce: call.nonce ?? 0,
              serialized: "0xraw",
            });
          } catch (error) {
            // What the real `TxSender` does with anything up to and including `onSigned`: nothing
            // has been broadcast, and the caller must be able to tell that apart from a failed send.
            throw new PreBroadcastError(error);
          }
          return "0xhash" as Hex;
        }),
      });

    it("refuses to broadcast", async () => {
      const store = tickingStore();
      const { exec } = autoExecutor(revivedDuringSend(store), store);

      const out = await exec.commit(CALL, claim("p"));

      expect(out).toMatchObject({ kind: "aborted" });
    });

    // `broadcastAttempted: false` is what keeps this off the consecutive-failure breaker: nothing
    // reached the chain, so it is not evidence the chain is rejecting us.
    it("reports it as pre-broadcast, not as a failed send", async () => {
      const store = tickingStore();
      const { exec } = autoExecutor(revivedDuringSend(store), store);

      const out = await exec.commit(CALL, claim("p"));

      expect(out).toMatchObject({ broadcastAttempted: false });
    });

    // The row now belongs to the attempt that revived it, which may be mid-send itself. Stamping
    // our error onto it would hide a live attempt behind a failure that is not its own.
    it("leaves the revived attempt untouched", async () => {
      const store = tickingStore();
      const { exec } = autoExecutor(revivedDuringSend(store), store);

      await exec.commit(CALL, claim("p"));

      const row = store.get(idempotencyKey(claim("p")));
      expect(row?.status).toBe("pending");
      expect(row?.nonce).toBeNull();
      expect(row?.txHash).toBeNull();
      expect(row?.error).toBeNull();
    });
  });

  it("a PreBroadcastError raised AFTER the durable record still leaves the intent live", async () => {
    // The insufficient-funds case: a lenient node prices the tx, so it is signed and `onSigned`
    // persists nonce + hash, and only then does the broadcast get refused. Two things must hold at
    // once, and they pull in opposite directions:
    //
    //   `broadcastAttempted: false` — the node queued nothing, so the risk gate abandons the slot
    //   and an empty gas tank cannot march the consecutive-failure breaker toward a halt.
    //
    //   status `submitted` — NOT terminal. The recorded hash outlives this call, so reconcile,
    //   not the sender, decides the intent's fate; the nonce stays fenced until it does. Settling
    //   it here would be faster but would have to be right about a tx it can no longer observe.
    //
    // The cost is that a refused send holds its nonce for the unknown-tx grace window. That is
    // deliberate, and this test exists to make changing it a conscious act.
    const store = tickingStore();
    const { exec } = autoExecutor(
      autoSender({
        send: vi.fn(async (call, onSigned) => {
          await onSigned?.({ hash: "0xhash" as Hex, nonce: call.nonce ?? 0, serialized: "0xraw" });
          throw new PreBroadcastError(new Error("insufficient funds for gas * price + value"));
        }),
      }),
      store
    );

    const out = await exec.commit(CALL, claim("p"));

    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
    const row = store.get(idempotencyKey(claim("p")));
    expect(row?.status).toBe("submitted");
    expect(row).toMatchObject({ txHash: "0xhash", nonce: 7 }); // the pre-broadcast record survived
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
      reader: createChainReader(autoPublicClient()),
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

    // Through the `TxSender`, NOT `walletClient.writeContract`. The sender is what carries the
    // submission policy, so an approval sent any other way would go to the public mempool while the
    // engine's own transactions went private — two routes on one nonce sequence, under two different
    // assumptions about who can see them.
    it("approves through the sender + waits the receipt when allowance is short", async () => {
      const pc = autoPublicClient(allowanceReader(0n));
      (autoWallet.writeContract as ReturnType<typeof vi.fn>).mockClear();
      const sender = autoSender();
      const { exec } = autoExecutor(sender, undefined, pc);

      const result = await exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n });

      expect(result).toEqual({ kind: "satisfied" });
      // Two arguments now: the call, and the `onSigned` hook that durably records nonce + hash
      // before the approval reaches the chain — the same pre-broadcast record `commit` makes.
      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          address: WBTC,
          functionName: "approve",
          args: [SPENDER, expect.anything()],
        }),
        expect.any(Function)
      );
      expect(autoWallet.writeContract).not.toHaveBeenCalled();
      expect(pc.waitForTransactionReceipt).toHaveBeenCalled();
    });

    // The reason approvals are claimed at all, and it is nonce safety rather than idempotency:
    // `liveNonceFloor` fences a reserved nonce by walking persisted intents, so a send with no
    // intent has nothing fencing it. Invisible under public submission (the node's own pending count
    // covers it) and unsafe under private submission, where the node cannot see the transaction —
    // the next resync would rewind onto the nonce and sign over a live approval.
    it("records an intent so the approval's nonce is fenced like every other send", async () => {
      const store = createMemoryStateStore();
      const pc = autoPublicClient(allowanceReader(0n));
      const { exec } = autoExecutor(autoSender(), store, pc);

      await exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n });

      const row = store.get(
        idempotencyKey({ chainId: 31337, target: WBTC, action: "approval", subject: SPENDER })
      );
      expect(row).toMatchObject({ status: "confirmed", txHash: "0xhash", nonce: 7 });
    });

    // A second approval while one is in flight would race it on a nonce. The caller is told the
    // allowance is not ready and comes back next cycle, rather than sending a competing transaction.
    it("refuses a second approval while one is already live", async () => {
      const store = createMemoryStateStore();
      const pc = autoPublicClient(allowanceReader(0n));
      const { exec } = autoExecutor(autoSender(), store, pc);
      await store.recordIntent({
        chainId: 31337,
        target: WBTC,
        action: "approval",
        subject: SPENDER,
      });

      const result = await exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n });

      expect(result.kind).toBe("duplicate");
    });

    // Approvals are the intents the two engines genuinely share, so this is where a revived attempt
    // is most reachable: both call `ensureAllowance` for the same token and spender.
    it("leaves a revived approval attempt untouched when its send fails", async () => {
      const store = tickingStore();
      const id = idempotencyKey({
        chainId: 31337,
        target: WBTC,
        action: "approval",
        subject: SPENDER,
      });
      const pc = autoPublicClient(allowanceReader(0n));
      const { exec } = autoExecutor(
        autoSender({
          send: vi.fn(async () => {
            // Another engine resolves this attempt and a later cycle re-claims the subject.
            await store.transition(id, "failed", { error: "resolved by the other engine" });
            await store.recordIntent({
              chainId: 31337,
              target: WBTC,
              action: "approval",
              subject: SPENDER,
            });
            throw new Error("rpc timeout");
          }),
        }),
        store,
        pc
      );

      await expect(
        exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n })
      ).rejects.toThrow("rpc timeout");

      const row = store.get(id);
      expect(row?.status).toBe("pending");
      expect(row?.error).toBeNull();
    });

    // The mirror of the case above: here the record *did* land, so the row is provably this
    // attempt's and the ambiguous send must be written onto it — under private submission that
    // write is what carries the relay horizon, and without one the nonce is fenced forever.
    it("marks its own attempt submitted when the broadcast fails after signing", async () => {
      const store = tickingStore();
      const pc = autoPublicClient(allowanceReader(0n));
      const { exec } = autoExecutor(
        autoSender({
          send: vi.fn(async (call, onSigned) => {
            await onSigned?.({
              hash: "0xhash" as Hex,
              nonce: call.nonce ?? 0,
              serialized: "0xraw",
            });
            throw new Error("ECONNRESET");
          }),
        }),
        store,
        pc
      );

      await expect(
        exec.ensureAllowance({ token: WBTC, spender: SPENDER, required: 100n })
      ).rejects.toThrow("ECONNRESET");

      const row = store.get(
        idempotencyKey({ chainId: 31337, target: WBTC, action: "approval", subject: SPENDER })
      );
      expect(row).toMatchObject({ status: "submitted", txHash: "0xhash", error: "ECONNRESET" });
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
  publicClient = manualPublicClient(),
  intentTtlMs = 0, // expiry disabled by default; the expiry tests set it explicitly
  intentStuckMs = 0, // stuck-check disabled by default; the stuck tests set it explicitly
  now?: () => number
) {
  return createManualExecutor({
    store,
    publicClient,
    notifier,
    identity: { from: OPERATOR, chainId: 31337 },
    logger: silentLogger,
    intentTtlMs,
    intentStuckMs,
    now,
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

  it("carries an `expiresAt` deadline in the notification when a TTL is set", async () => {
    const { notifier, events } = fakeNotifier();
    const before = Date.now();
    const exec = manualExecutor(createMemoryStateStore(), notifier, manualPublicClient(), 5_000);

    await exec.commit(CALL, claim("p"));

    const event = events[0];
    if (event.kind !== "manual-intent") throw new Error("expected a manual-intent event");
    expect(event.expiresAt).toBeGreaterThanOrEqual(before + 5_000);
  });

  it("omits `expiresAt` when the TTL is disabled (0)", async () => {
    const { notifier, events } = fakeNotifier();
    const exec = manualExecutor(createMemoryStateStore(), notifier, manualPublicClient(), 0);

    await exec.commit(CALL, claim("p"));

    const event = events[0];
    if (event.kind !== "manual-intent") throw new Error("expected a manual-intent event");
    expect(event.expiresAt).toBeUndefined();
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

    it("proposes the approval (target=token, subject=spender) — broadcasting nothing", async () => {
      const store = createMemoryStateStore();
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(
        store,
        notifier,
        manualPublicClient({ readContract: vi.fn(async () => 0n) })
      );

      const result = await exec.ensureAllowance({ token: TOKEN, spender: SPENDER, required: 100n });

      expect(result.kind).toBe("proposed");
      // `target` is the token (the contract `approve` is sent to), `subject` the spender — both in
      // the key, so two engines approving one token for different spenders never collide.
      const row = store.all()[0];
      expect(row).toMatchObject({
        action: "approval",
        target: TOKEN,
        subject: SPENDER,
        status: "proposed",
      });
      expect(events[0]).toMatchObject({ kind: "manual-intent", action: "approval" });
    });
  });

  // Without this sweep a proposal nobody actions stays `proposed` forever and — deduped on payload
  // hash — blocks its subject from ever re-notifying. `reconcile` expires it after the TTL.
  describe("proposal expiry (reconcile sweep)", () => {
    it("expires an un-actioned proposal past the TTL, freeing the subject to re-propose", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(store, notifier, manualPublicClient(), 5_000); // 5s TTL

      await exec.commit(CALL, claim("p")); // proposed at t=1000
      expect(store.get(idempotencyKey(claim("p")))?.status).toBe("proposed");

      clock = 1_000 + 5_001; // one ms past the TTL
      await exec.reconcile();
      expect(store.get(idempotencyKey(claim("p")))?.status).toBe("expired");

      // `expired` is terminal ⇒ revivable: a fresh proposal for the same subject re-notifies.
      const out = await exec.commit(CALL, claim("p"));
      expect(out.kind).toBe("proposed");
      expect(events).toHaveLength(2);
    });

    it("leaves a proposal alone within the TTL", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      const exec = manualExecutor(store, fakeNotifier().notifier, manualPublicClient(), 5_000);

      await exec.commit(CALL, claim("p"));
      clock = 1_000 + 100; // still within the window
      await exec.reconcile();
      expect(store.get(idempotencyKey(claim("p")))?.status).toBe("proposed");
    });

    it("intentTtlMs=0 disables the sweep (never expires)", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      const exec = manualExecutor(store, fakeNotifier().notifier, manualPublicClient(), 0);

      await exec.commit(CALL, claim("p"));
      clock = 1_000 + 10 ** 9; // far past any TTL
      await exec.reconcile();
      expect(store.get(idempotencyKey(claim("p")))?.status).toBe("proposed");
    });

    it("sweeps proposals of any action, not just the reconciled one", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      const exec = manualExecutor(
        store,
        fakeNotifier().notifier,
        manualPublicClient({ readContract: vi.fn(async () => 0n) }), // allowance short ⇒ proposes
        5_000
      );

      // An `approval` proposal — no engine owns that action, so only an unscoped sweep reaches it.
      await exec.ensureAllowance({
        token: "0x0000000000000000000000000000000000000abc" as Address,
        spender: "0x0000000000000000000000000000000000000def" as Address,
        required: 100n,
      });
      expect(store.all()[0]?.status).toBe("proposed");

      clock = 1_000 + 5_001;
      await exec.reconcile(); // a DIFFERENT action still sweeps it

      expect(store.all()[0]?.status).toBe("expired");
    });
  });

  // A claimed proposal (operator mid-signing) or a submitted intent (broadcast, not yet mined) that
  // sits too long is the signal of an abandoned claim or a dropped tx — surfaced, once, for a human.
  describe("intent-stuck alerts (reconcile)", () => {
    const stuckEvents = (events: NotificationEvent[]) =>
      events.filter((e) => e.kind === "intent-stuck");

    async function claimedProposal(store: MemoryStateStore) {
      // Build a real proposal, then claim it — both at the store's current clock.
      const notifier = fakeNotifier().notifier;
      await manualExecutor(store, notifier).commit(CALL, claim("p"));
      const id = idempotencyKey(claim("p"));
      const row = store.get(id);
      if (!row?.payloadHash) throw new Error("expected a proposed row");
      await store.claimProposal(id, row.payloadHash);
      return id;
    }

    it("warns for a claimed proposal past the threshold", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      const id = await claimedProposal(store);
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(store, notifier, manualPublicClient(), 0, 60_000, () => clock);

      clock = 1_000 + 60_001; // past the stuck window
      await exec.reconcile();

      expect(stuckEvents(events)).toMatchObject([{ kind: "intent-stuck", intentId: id }]);
    });

    it("stays quiet within the threshold, then warns only once", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      await claimedProposal(store);
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(store, notifier, manualPublicClient(), 0, 60_000, () => clock);

      clock = 1_000 + 100; // still fresh
      await exec.reconcile();
      expect(stuckEvents(events)).toHaveLength(0);

      clock = 1_000 + 60_001; // now stuck
      await exec.reconcile();
      await exec.reconcile(); // a persistently-stuck intent must not re-alert
      expect(stuckEvents(events)).toHaveLength(1);
    });

    it("intentStuckMs=0 disables the check", async () => {
      let clock = 1_000;
      const store = createMemoryStateStore(() => clock);
      await claimedProposal(store);
      const { notifier, events } = fakeNotifier();
      const exec = manualExecutor(store, notifier, manualPublicClient(), 0, 0, () => clock);

      clock = 1_000 + 10 ** 9;
      await exec.reconcile();
      expect(stuckEvents(events)).toHaveLength(0);
    });
  });
});

// The wiring `createAutoExecutorFromWallet` does between the composition root's submission choice
// and the transaction that carries it. Typecheck cannot see a dropped field here — the parameter is
// optional, so omitting it compiles and silently broadcasts publicly, which is exactly the failure
// an operator cannot observe until a liquidation is front-run.
describe("createAutoExecutorFromWallet — submission routing", () => {
  const wallet = {
    account: { address: "0xsigner" },
    chain: { id: 31337 },
    prepareTransactionRequest: vi.fn(async (r: { nonce?: number }) => ({
      ...r,
      nonce: r.nonce ?? 1,
    })),
    signTransaction: vi.fn(async () => "0xraw" as Hex),
  } as unknown as Parameters<typeof createAutoExecutorFromWallet>[0]["walletClient"];

  const clients = () => {
    const publicClient = autoPublicClient({
      sendRawTransaction: vi.fn(async () => "0xpublic" as Hex),
      readContract: vi.fn(async () => 0n),
    });
    return { publicClient };
  };

  it("routes sends through an injected submitter, never the node", async () => {
    const { publicClient } = clients();
    const submitter = { send: vi.fn(async () => "0xprivate" as Hex) };
    const exec = createAutoExecutorFromWallet({
      nonces: allocator(),
      publicClient,
      walletClient: wallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
      submission: {
        submitter,
        reader: createChainReader(publicClient),
        reclaimMarginBlocks: 3,
        horizon: async () => 125,
      },
    });

    const out = await exec.commit(CALL, { target: TARGET, action: "liquidation", subject: "p" });

    expect(out).toMatchObject({ kind: "broadcast" });
    expect(submitter.send).toHaveBeenCalledWith("0xraw");
    expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("falls back to the node's mempool when none is injected — today's behaviour", async () => {
    const { publicClient } = clients();
    const exec = createAutoExecutorFromWallet({
      nonces: allocator(),
      publicClient,
      walletClient: wallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
    });

    await exec.commit(CALL, { target: TARGET, action: "liquidation", subject: "p" });

    expect(publicClient.sendRawTransaction).toHaveBeenCalled();
  });

  // A `sender` together with a `submission` is not tested here because it does not compile:
  // `AutoExecutorDeps` is a union, so the two are mutually exclusive at the type level rather than
  // caught by a runtime throw.

  // Under private submission the recorded horizon is the *only* thing that ever frees this nonce —
  // the reader fails closed by design. An intent submitted without one is fenced forever, and every
  // later send queues behind it.
  describe("records the relay horizon on the intent it submits", () => {
    const submitted = async (over: { submitterSend?: () => Promise<Hex> } = {}) => {
      const { publicClient } = clients();
      const store = createMemoryStateStore();
      const exec = createAutoExecutorFromWallet({
        store,
        nonces: allocator(),
        publicClient,
        walletClient: wallet,
        txReceiptTimeoutMs: 1000,
        logger: silentLogger,
        submission: {
          submitter: { send: over.submitterSend ?? (async () => "0xprivate" as Hex) },
          reader: createChainReader(publicClient),
          reclaimMarginBlocks: 3,
          horizon: async () => 125,
        },
      });
      const input = claim("p");
      await exec.commit(CALL, input).catch(() => {});
      return store.get(idempotencyKey(input));
    };

    it("on a clean broadcast", async () => {
      expect(await submitted()).toMatchObject({ status: "submitted", relayMaxBlock: 125 });
    });

    // The acute case: the relay may or may not have taken this transaction, so the intent stays
    // live — which is precisely when something has to be able to expire it.
    it("on an ambiguous one", async () => {
      const intent = await submitted({
        submitterSend: async () => {
          throw new Error("ECONNRESET");
        },
      });
      expect(intent).toMatchObject({ status: "submitted", relayMaxBlock: 125 });
    });
  });
});

// The last word before a broadcast. `openSlot` reads the gate once per cycle and a halt can land
// after it — the kill switch, or a periodic code-hash check finding a target's bytecode changed.
// Between admission and the send this callback is the only thing left, and it covers approvals too:
// an approval is a transaction, and the halt that stopped a liquidation has no reason to permit
// granting an allowance to the contract that caused it.
describe("createAutoExecutor — the broadcast guard", () => {
  const refuse = () => {
    throw new PreBroadcastError("halted");
  };
  const crashFor = (publicClient = autoPublicClient()) =>
    createCrashSafety({
      nonces: allocator(),
      reader: createChainReader(publicClient),
      signer: "0xsigner" as Address,
      logger: silentLogger,
    });

  it("stops a commit, and reports it as pre-broadcast so nothing is presumed in flight", async () => {
    const sender = autoSender();
    const exec = createAutoExecutor({
      crash: crashFor(),
      sender,
      publicClient: autoPublicClient(),
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      assertCanBroadcast: refuse,
      logger: silentLogger,
    });

    const out = await exec.commit(CALL, { target: TARGET, action: "liquidation", subject: "p" });

    expect(sender.send).not.toHaveBeenCalled();
    // `broadcastAttempted: false` is what settles the slot `abandoned` rather than blaming the
    // breaker for a transaction that never existed.
    expect(out).toMatchObject({ kind: "aborted", broadcastAttempted: false });
  });

  it("stops an approval too", async () => {
    const sender = autoSender();
    const exec = createAutoExecutor({
      crash: crashFor(),
      sender,
      publicClient: autoPublicClient({ readContract: vi.fn(async () => 0n) }),
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      assertCanBroadcast: refuse,
      logger: silentLogger,
    });

    await expect(
      exec.ensureAllowance({ token: TARGET, spender: OPERATOR, required: 1n })
    ).rejects.toThrow(/halted/);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("is out of the way when nothing refuses", async () => {
    const sender = autoSender();
    const exec = createAutoExecutor({
      crash: crashFor(),
      sender,
      publicClient: autoPublicClient(),
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
    });

    const out = await exec.commit(CALL, { target: TARGET, action: "liquidation", subject: "p" });

    expect(out).toMatchObject({ kind: "broadcast" });
    expect(sender.send).toHaveBeenCalled();
  });
});

// A stuck approval must not pin the engine. Its intent is claimed under `action: "approval"`, which
// no engine owns — so a reconcile scoped to the caller's action would leave it live forever, and a
// live approval intent makes every later `ensureAllowance` a duplicate: the bot skips every
// opportunity while looking perfectly healthy. Reconcile is therefore unscoped, matching MANUAL and
// matching `liveNonceFloor`, which already spans every action.
describe("createAutoExecutor — reconcile is unscoped", () => {
  it("asks the store for every in-flight intent, not one action's", async () => {
    const seen: Array<string | undefined> = [];
    const crash = {
      reconcile: async (action?: string) => {
        seen.push(action);
      },
      resyncNonces: async () => {},
      transition: async () => {},
      claim: async () => ({ claimed: true }),
      markPending: async () => {},
      send: async (fn: (n: number) => Promise<Hex>) => fn(1),
    } as unknown as Parameters<typeof createAutoExecutor>[0]["crash"];

    const exec = createAutoExecutor({
      crash,
      sender: autoSender(),
      publicClient: autoPublicClient(),
      walletClient: autoWallet,
      txReceiptTimeoutMs: 1000,
      logger: silentLogger,
    });
    await exec.reconcile();

    expect(seen).toEqual([undefined]);
  });
});
