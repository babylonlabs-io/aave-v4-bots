import {
  type IntentInput,
  type StateStore,
  type TxIntent,
  createMemoryStateStore,
  idempotencyKey,
} from "@repo/persistence";
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  toEventSelector,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  type ChainReader,
  type SafeExecutionOutcome,
  UNKNOWN_TX_GRACE_MS,
  createChainReader,
} from "./liveness";
import { reconcilePending } from "./reconcile";

const SIGNER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;

function input(subject: string, over: Partial<IntentInput> = {}): IntentInput {
  return { chainId: 31337, target: TARGET, action: "liquidation", subject, ...over };
}

/**
 * A clock reading `ms` into the future, so an intent the store just recorded is judged as though it
 * were `ms` old — which is what decides whether an "unknown to the node" answer is trustworthy.
 */
const aged = (ms: number) => () => Date.now() + ms;

/**
 * A `ChainReader` with scripted receipt statuses and fixed latest/pending nonces. `known`
 * defaults to `true`: a recorded hash the node still knows about (i.e. in flight), which is
 * the case for every tx that was actually broadcast.
 */
function reader(over: {
  receipts?: Record<string, "success" | "reverted" | null>;
  safeExec?: Record<string, SafeExecutionOutcome>;
  latest?: number;
  pending?: number;
  known?: boolean;
  head?: number;
  /** What a scan of the Safe's own logs for this SafeTx turns up. */
  found?: { txHash: Hex; success: boolean } | null;
  scanThrows?: boolean;
}): ChainReader {
  return {
    async getReceiptStatus(hash) {
      return over.receipts?.[hash] ?? null;
    },
    async getNonce(_address, tag) {
      return (tag === "latest" ? over.latest : over.pending) ?? 0;
    },
    async getBlockNumber() {
      return over.head ?? 0;
    },
    async isKnown() {
      return over.known ?? true;
    },
    async getSafeExecution(txHash) {
      return over.safeExec?.[txHash] ?? null;
    },
    async findSafeExecution() {
      if (over.scanThrows) throw new Error("query returned more than 10000 results");
      return over.found ?? null;
    },
  };
}

describe("reconcilePending", () => {
  it("confirms a submitted intent whose receipt succeeded", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": "success" }, latest: 5, pending: 6 }),
    });

    expect(summary).toMatchObject({ examined: 1, confirmed: 1, failed: 0, stillInFlight: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("confirmed");
  });

  it("fails a submitted intent whose receipt reverted", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": "reverted" }, latest: 6, pending: 6 }),
    });

    expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("fails a no-hash pending intent whose reserved nonce was already mined", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 4 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 5, pending: 5 }), // nonce 4 already mined, no hash to check
    });

    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("fails a submitted intent whose tx was dropped (nonce mined past, no receipt)", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 6, pending: 6 }),
    });

    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
  });

  it("leaves a genuinely-pending submitted intent in-flight", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 6 }),
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0, confirmed: 0 });
  });

  it("fails a pending intent that was never broadcast (re-drivable)", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 7 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 7, pending: 7 }), // nothing at nonce 7 yet
    });

    expect(summary).toMatchObject({ failed: 1 });
    expect(store.all()[0].status).toBe("failed");
  });

  it("keeps a pending intent live when its reserved nonce is already in the mempool", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "pending", { nonce: 7 });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 7, pending: 8 }), // a tx occupies nonce 7 in the mempool
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
    expect(store.all()[0].status).toBe("submitted");
  });

  it("fails a signed intent the node rejected (unknown hash, nonce slot still free)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    // Signed and recorded pre-broadcast, then the node refused it (e.g. insufficient funds).
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      // Nonce 5 never made it to the mempool, and the node has never seen the hash.
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: false }),
      now: aged(UNKNOWN_TX_GRACE_MS + 1), // past the grace window, so the "no" is trustworthy
    });

    // Nothing is on chain — re-drivable. Left in-flight it would be pinned forever: the same
    // rejection blocks every later send, so no tx would ever mine past nonce 5 to release it.
    expect(summary).toMatchObject({ failed: 1, stillInFlight: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("failed");
  });

  // Behind a load-balanced RPC pool the node we ask need not be the node we broadcast to, so a tx
  // that IS on the wire can read as unknown until it propagates. Acting on that immediately is what
  // turns a routing artifact into a double-submitted liquidation.
  it("does NOT fail a just-signed intent the node has not seen yet (grace window)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "submitted", { nonce: 5, txHash: "0xhash" as Hex });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: false }),
      now: aged(1_000), // recorded a second ago — far too young for "unknown" to mean rejected
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
    expect(store.all().find((r) => r.id === id)?.status).toBe("submitted"); // not re-drivable yet
  });

  it("keeps a signed intent live while the node still knows its tx", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      // Broadcast landed; this node's `pending` count just hasn't caught up (some providers
      // never reflect the mempool). The tx is known, so it must NOT be treated as rejected.
      reader: reader({ receipts: { "0xhash": null }, latest: 5, pending: 5, known: true }),
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
  });

  it("no-ops with nothing in flight", async () => {
    const store = createMemoryStateStore();
    const summary = await reconcilePending({ store, signer: SIGNER, reader: reader({}) });
    expect(summary.examined).toBe(0);
  });

  // A keyless MANUAL bot has no signer nonce to read: its in-flight intents were broadcast by the
  // operator, so every one has `nonce === null`. Reconcile must resolve them by receipt alone and
  // issue no `getTransactionCount` — otherwise a keyless process makes a call it has no basis for.
  it("issues NO nonce reads when every in-flight intent is nonce-less (keyless path)", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    // An operator-broadcast intent: a hash, but no nonce (see StateStore.markBroadcast).
    await store.transition(id, "submitted", { txHash: "0xhash" as Hex });

    const getNonce = vi.fn(async () => 0);
    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: { ...reader({ receipts: { "0xhash": "success" } }), getNonce },
    });

    expect(getNonce).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ confirmed: 1 }); // still resolved, by receipt
  });

  it("does read the signer nonce when some in-flight intent carries one (AUTO path)", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const getNonce = vi.fn(async (_a: Address, tag: "latest" | "pending") =>
      tag === "latest" ? 5 : 6
    );
    await reconcilePending({
      store,
      signer: SIGNER,
      reader: { ...reader({ receipts: { "0xhash": null } }), getNonce },
    });

    expect(getNonce).toHaveBeenCalled(); // the nonce branches need real counts
  });
});

describe("reconcilePending — Safe custody (resolves by the Execution event, not the receipt)", () => {
  // In MANUAL the executor address IS the Safe, and the executor passes it to `reconcilePending`
  // as `signer` — which is exactly the address the Safe's Execution event is matched against.
  const SAFE = SIGNER;
  const EXEC_TX = `0x${"c".repeat(64)}` as Hex;
  const HASH = `0x${"a".repeat(64)}` as Hex;
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const safeEnvelope = {
    safeNonce: 3,
    operation: 0 as const,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    safeVersion: "1.4.1",
    safeTxHash: `0x${"e".repeat(64)}` as Hex,
    claimBlock: 1000,
  };
  const proposedTx = { chainId: 31337, to: TARGET, data: "0x" as Hex, value: "0" };

  // A submitted Safe intent: proposed → claimed (with envelope) → markBroadcast(execTransaction tx).
  async function submittedSafeIntent(store: ReturnType<typeof createMemoryStateStore>) {
    const id = idempotencyKey(input("p"));
    await store.propose(input("p"), proposedTx, HASH);
    await store.claimProposal(id, HASH, safeEnvelope);
    await store.markBroadcast(id, EXEC_TX, HASH);
    return id;
  }

  it("confirms on ExecutionSuccess", async () => {
    const store = createMemoryStateStore();
    const id = await submittedSafeIntent(store);

    const summary = await reconcilePending({
      store,
      signer: SAFE,
      reader: reader({ safeExec: { [EXEC_TX]: "success" } }),
    });

    expect(summary).toMatchObject({ confirmed: 1, failed: 0, stillInFlight: 0 });
    expect(store.get(id)?.status).toBe("confirmed");
  });

  it("fails on ExecutionFailure — the inner call reverted though the outer tx succeeded", async () => {
    const store = createMemoryStateStore();
    const id = await submittedSafeIntent(store);

    const summary = await reconcilePending({
      store,
      signer: SAFE,
      reader: reader({ safeExec: { [EXEC_TX]: "failure" } }),
    });

    expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
    expect(store.get(id)?.status).toBe("failed");
    // ...and the subject is revivable for a fresh proposal.
    expect((await store.propose(input("p"), proposedTx, HASH)).recorded).toBe(true);
  });

  it("fails when the outer execTransaction itself reverted (receipt status 0)", async () => {
    const store = createMemoryStateStore();
    const id = await submittedSafeIntent(store);

    const summary = await reconcilePending({
      store,
      signer: SAFE,
      reader: reader({ safeExec: { [EXEC_TX]: "reverted" } }),
    });

    expect(summary.failed).toBe(1);
    expect(store.get(id)?.status).toBe("failed");
  });

  it("does NOT confirm a mined tx with no matching Execution event — fails + warns", async () => {
    const store = createMemoryStateStore();
    const id = await submittedSafeIntent(store);
    const warn = vi.fn();

    const summary = await reconcilePending({
      store,
      signer: SAFE,
      reader: reader({ safeExec: { [EXEC_TX]: "no-event" } }),
      logger: { info: vi.fn(), warn },
    });

    expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
    expect(store.get(id)?.status).toBe("failed");
    expect(warn).toHaveBeenCalled();
  });

  it("leaves it in-flight while the tx is not mined yet", async () => {
    const store = createMemoryStateStore();
    const id = await submittedSafeIntent(store);

    const summary = await reconcilePending({
      store,
      signer: SAFE,
      reader: reader({ safeExec: {} }), // null ⇒ no receipt yet
    });

    expect(summary).toMatchObject({ stillInFlight: 1, confirmed: 0, failed: 0 });
    expect(store.get(id)?.status).toBe("submitted");
  });

  // A SafeTx's calldata carries its owner signatures, so the transaction that executes it need not
  // be the one we recorded — a replacement the operator sent, or anyone who copied the calldata.
  // Judging only by the recorded hash then reads a landed action as pending forever (MANUAL intents
  // carry no nonce, so nothing else will ever release the subject) or as failed.
  describe("when the SafeTx executed in a different transaction", () => {
    const ELSEWHERE = "0xe15ewhere" as Hex;
    /** A clock past the grace window, so the recorded hash's absence is old enough to mean something. */
    const AGED = { now: () => Date.now() + 60_000, graceMs: 1_000 };

    it("confirms from the Safe's own logs when the recorded tx never mined", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({ found: { txHash: ELSEWHERE, success: true } }),
        ...AGED,
      });

      expect(summary).toMatchObject({ confirmed: 1, stillInFlight: 0 });
      expect(store.get(id)?.status).toBe("confirmed");
    });

    // The whole point of recording it: the hash on the row has to be the one an operator can look
    // up, not one that was never mined.
    it("records the transaction that actually carried it", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({ found: { txHash: ELSEWHERE, success: true } }),
        ...AGED,
      });

      expect(store.get(id)?.txHash).toBe(ELSEWHERE);
    });

    // A recorded tx that reverted is what losing a duplicate looks like: the winner spent the Safe
    // nonce, so ours could not execute. The action still happened.
    it("confirms when the recorded tx reverted but the SafeTx landed elsewhere", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({
          safeExec: { [EXEC_TX]: "reverted" },
          found: { txHash: ELSEWHERE, success: true },
        }),
      });

      expect(summary).toMatchObject({ confirmed: 1, failed: 0 });
      expect(store.get(id)?.txHash).toBe(ELSEWHERE);
    });

    it("fails when the scan finds the SafeTx executed and its inner call reverted", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({ found: { txHash: ELSEWHERE, success: false } }),
        ...AGED,
      });

      expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
      expect(store.get(id)?.status).toBe("failed");
    });

    // An absence this young means nothing — the recorded transaction is simply not mined yet — and
    // scanning on every cycle from the moment of broadcast is a growing `eth_getLogs` for nothing.
    it("waits out the grace window before asking", async () => {
      const store = createMemoryStateStore();
      const findSafeExecution = vi.fn(async () => null);

      await submittedSafeIntent(store);
      await reconcilePending({
        store,
        signer: SAFE,
        reader: { ...reader({}), findSafeExecution },
        now: () => Date.now(),
      });

      expect(findSafeExecution).not.toHaveBeenCalled();
    });

    it("leaves the intent in flight when the SafeTx is genuinely nowhere", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({ found: null }),
        ...AGED,
      });

      expect(summary).toMatchObject({ stillInFlight: 1, confirmed: 0, failed: 0 });
      expect(store.get(id)?.status).toBe("submitted");
    });

    // The scan's range grows with the intent's age, so a provider's log-range cap is a matter of
    // time. It must cost this intent its answer for one cycle, not take the whole pass down with it
    // — every other in-flight intent still needs resolving.
    it("survives a scan the provider refuses", async () => {
      const store = createMemoryStateStore();
      const id = await submittedSafeIntent(store);

      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: reader({ scanThrows: true }),
        ...AGED,
      });

      expect(summary).toMatchObject({ stillInFlight: 1 });
      expect(store.get(id)?.status).toBe("submitted");
    });

    // `no-event` means the recorded tx mined and carried no Execution event for this SafeTx — so the
    // hash on the row is not the transaction we think it is. Resolving that from a scan would paper
    // over a mis-recorded hash with an unrelated execution; it stays anomalous.
    it("does not paper over a mined tx that carries no Execution event", async () => {
      const store = createMemoryStateStore();
      const findSafeExecution = vi.fn(async () => ({ txHash: ELSEWHERE, success: true }));

      const id = await submittedSafeIntent(store);
      const summary = await reconcilePending({
        store,
        signer: SAFE,
        reader: { ...reader({ safeExec: { [EXEC_TX]: "no-event" } }), findSafeExecution },
      });

      expect(summary).toMatchObject({ failed: 1, confirmed: 0 });
      expect(store.get(id)?.txHash).toBe(EXEC_TX);
      expect(findSafeExecution).not.toHaveBeenCalled();
    });
  });

  // An envelope alone does not make an intent judgeable by the Safe resolver: with no recorded
  // outer hash there is nothing to fetch a receipt for. It belongs to the hashless path, which
  // reasons from the reserved nonce instead.
  it("routes an envelope with no recorded hash away from the Safe resolver", async () => {
    const store = createMemoryStateStore();
    const id = idempotencyKey(input("p"));
    await store.propose(input("p"), proposedTx, HASH);
    await store.claimProposal(id, HASH, safeEnvelope);
    await store.transition(id, "submitted", {});
    const getSafeExecution = vi.fn(async () => null);

    await reconcilePending({
      store,
      signer: SAFE,
      reader: { ...reader({}), getSafeExecution },
      now: () => Date.now() + 60_000,
    });

    expect(getSafeExecution).not.toHaveBeenCalled();
    expect(store.get(id)?.status).toBe("failed");
  });

  it("never reads the signer nonce for a Safe intent (nonce is null)", async () => {
    const store = createMemoryStateStore();
    await submittedSafeIntent(store);
    const getNonce = vi.fn(async () => 0);

    await reconcilePending({
      store,
      signer: SAFE,
      reader: { ...reader({ safeExec: { [EXEC_TX]: "success" } }), getNonce },
    });

    expect(getNonce).not.toHaveBeenCalled();
  });
});

// MANUAL + `eoa`: the operator broadcasts from their own wallet, so `markBroadcast` records a hash
// and no nonce. Every branch below the receipt check reasons from the *bot's* nonce sequence, which
// says nothing about a transaction the bot never signed.
describe("an operator-broadcast intent with no nonce of ours", () => {
  const payloadHash = `0x${"a".repeat(64)}` as Hex;
  const tx = { chainId: 31337, to: TARGET, data: "0x" as Hex, value: "0" };

  const operatorBroadcast = async (store: ReturnType<typeof createMemoryStateStore>) => {
    const id = idempotencyKey(input("p"));
    await store.propose(input("p"), tx, payloadHash);
    await store.claimProposal(id, payloadHash);
    await store.markBroadcast(id, "0xopertx" as Hex, payloadHash);
    return id;
  };

  it("is not read as dropped just because our own nonce has moved on", async () => {
    const store = createMemoryStateStore();
    const id = await operatorBroadcast(store);

    const summary = await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 9, pending: 9 }),
    });

    expect(summary).toMatchObject({ stillInFlight: 1, failed: 0 });
    expect(store.get(id)?.status).toBe("submitted");
  });

  // The nonce counts are only read when some intent carries one, so the branch above is reachable
  // exactly when a bot has both kinds in flight — a deployment switched between AUTO and MANUAL
  // with the previous mode's intents still unresolved.
  it("is not read as dropped even when a signed intent is in flight beside it", async () => {
    const store = createMemoryStateStore();
    const operatorId = await operatorBroadcast(store);
    const signed = { ...input("pos-2"), action: "liquidation" };
    await store.recordIntent(signed);
    await store.transition(idempotencyKey(signed), "submitted", {
      nonce: 4,
      txHash: "0xsigned" as Hex,
    });

    await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ latest: 9, pending: 9 }),
    });

    expect(store.get(operatorId)?.status).toBe("submitted");
  });

  it("still resolves from its receipt", async () => {
    const store = createMemoryStateStore();
    const id = await operatorBroadcast(store);

    await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({ receipts: { "0xopertx": "success" }, latest: 9, pending: 9 }),
    });

    expect(store.get(id)?.status).toBe("confirmed");
  });
});

// `updatedAt` comes from whichever process wrote the row — this bot, a previous run on another
// host, or operator-cli on a laptop — so a row can be stamped ahead of the clock reading it. Every
// guard here asks whether an age is *small*, and a future stamp makes it negative, so the row sits
// inside a grace window until real time catches up while its subject stays blocked.
describe("a row stamped ahead of this process's clock", () => {
  const pendingUnsent = async (store: ReturnType<typeof createMemoryStateStore>) => {
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "pending", {});
    return id;
  };

  const warnings = () => {
    const lines: string[] = [];
    return { logger: { info: () => {}, warn: (m: string) => lines.push(m) }, lines };
  };

  it("says so, naming the intent and how far ahead it is", async () => {
    const store = createMemoryStateStore();
    await pendingUnsent(store);
    const { logger, lines } = warnings();

    await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({}),
      logger,
      now: () => Date.now() - 10 * 60_000, // the row was written by a clock 10 minutes ahead
    });

    expect(lines.some((l) => l.includes("600s in the future"))).toBe(true);
  });

  // Two clocks tens of seconds apart are ordinary — operator-cli stamps rows from whatever laptop
  // it runs on — and a lead of the same order as the grace window can only hold a row for about as
  // long as the window was going to anyway. Waking someone for that trains them to ignore it.
  it("stays quiet about a lead too small to distort anything", async () => {
    const store = createMemoryStateStore();
    await pendingUnsent(store);
    const { logger, lines } = warnings();

    await reconcilePending({
      store,
      signer: SIGNER,
      reader: reader({}),
      logger,
      now: () => Date.now() - 45_000,
    });

    expect(lines.filter((l) => l.includes("in the future"))).toEqual([]);
  });

  // The contract of this guard: it reports, it does not decide. Which answer a disagreeing clock
  // deserves is genuinely unknown, so the row must resolve exactly as it would have without it.
  it("changes nothing about how the row resolves", async () => {
    const skewed = createMemoryStateStore();
    const normal = createMemoryStateStore();
    const id = await pendingUnsent(skewed);
    await pendingUnsent(normal);
    const aged = Date.now() + UNKNOWN_TX_GRACE_MS + 1;

    // Same row, same age past the grace window — one stamped by a clock far ahead, one not.
    const skewedSummary = await reconcilePending({
      store: skewed,
      signer: SIGNER,
      reader: reader({}),
      now: () => aged - 10 * 60_000,
    });
    const normalSummary = await reconcilePending({
      store: normal,
      signer: SIGNER,
      reader: reader({}),
      now: () => aged,
    });

    // Held live — the row is left untouched, which is the whole cost of the skew.
    expect(skewed.get(id)?.status).toBe("pending");
    expect(normal.get(id)?.status).toBe("failed");
    expect(skewedSummary).toMatchObject({ stillInFlight: 1 });
    expect(normalSummary).toMatchObject({ failed: 1 });
  });
});

// Ids identify a subject, not a try at it: a terminal row is revived in place for the next attempt.
// Two engines poll independently in the dual-engine service and `reconcile()` is not taken under the
// nonce lock, so a pass can decide against a row that is re-claimed before it writes — and a revived
// row is indistinguishable from the one it read, both `pending` with a null nonce and hash.
describe("a resolution racing a revived attempt", () => {
  it("does not land on the attempt that replaced the one it read", async () => {
    let clock = 1_700_000_000_000;
    const store = createMemoryStateStore(() => {
      clock += 1_000;
      return clock;
    });
    const id = idempotencyKey(input("p"));
    await store.recordIntent(input("p"));
    await store.transition(id, "pending", {});

    // The pass reads the row, and between that read and its write another engine resolves it and a
    // new cycle claims the subject again.
    const racing = {
      ...store,
      reconcile: async () => {
        const rows = await store.reconcile();
        await store.transition(id, "failed", { error: "resolved by the other engine" });
        await store.recordIntent(input("p"));
        return rows;
      },
    };

    const summary = await reconcilePending({
      store: racing,
      signer: SIGNER,
      reader: reader({}),
      now: () => clock + UNKNOWN_TX_GRACE_MS + 1,
    });

    // The pass still decided `failed` — it had no way to know — but the write found a row it had
    // never seen and was refused. The revived attempt keeps its own state.
    expect(summary).toMatchObject({ failed: 1 });
    expect(store.get(id)?.status).toBe("pending");
    expect(store.get(id)?.error).toBeNull();
  });
});

describe("reconcilePending under a chain outage", () => {
  // Fail closed: if we cannot read the chain we must leave in-flight intents exactly as they are.
  // Marking them failed would re-drive a possibly-mined tx on the next cycle.
  it("propagates the read error and leaves the intent in flight", async () => {
    const store = createMemoryStateStore();
    await store.recordIntent(input("p"));
    await store.transition(idempotencyKey(input("p")), "submitted", {
      nonce: 5,
      txHash: "0xhash" as Hex,
    });

    const outage: ChainReader = {
      getReceiptStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      getNonce: async (_a, tag) => (tag === "latest" ? 9 : 9), // chain has moved well past nonce 5
      getBlockNumber: async () => 0,
      getSafeExecution: async () => null,
      findSafeExecution: async () => null,
      isKnown: async () => true,
    };

    await expect(reconcilePending({ store, signer: SIGNER, reader: outage })).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(store.all()[0].status).toBe("submitted"); // untouched — not "failed"
  });
});

describe("createChainReader", () => {
  // The reason `ChainReader` is a port rather than a bare `PublicClient`: a missing receipt is an
  // answer ("still in the mempool"), not an error, and viem signals it by throwing.
  it("maps viem's TransactionReceiptNotFoundError to null", async () => {
    const publicClient = {
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: "0xhash" });
      },
    } as unknown as PublicClient;

    expect(await createChainReader(publicClient).getReceiptStatus("0xhash")).toBeNull();
  });

  // An RPC outage must NOT read as "not mined". `reconcilePending` would see a nonce the chain has
  // moved past, mark a live intent failed/dropped, and re-drive a tx that may already be mined —
  // the exact double-submit this whole layer exists to prevent.
  it("propagates a transport error instead of reporting 'no receipt'", async () => {
    const publicClient = {
      getTransactionReceipt: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    } as unknown as PublicClient;

    await expect(createChainReader(publicClient).getReceiptStatus("0xhash")).rejects.toThrow(
      "ECONNREFUSED"
    );
  });

  it("maps receipt status and forwards the nonce block tag", async () => {
    const tags: string[] = [];
    const publicClient = {
      getTransactionReceipt: async () => ({ status: "reverted" }),
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => {
        tags.push(blockTag);
        return 42;
      },
    } as unknown as PublicClient;

    const chain = createChainReader(publicClient);
    expect(await chain.getReceiptStatus("0xhash")).toBe("reverted");
    expect(await chain.getNonce(SIGNER, "pending")).toBe(42);
    expect(tags).toEqual(["pending"]);
  });

  // The resolver's scan is only as good as this wiring: it hands the port a `claimBlock` number and
  // the query wants a bigint anchor, and a transposed argument or a lost conversion would make the
  // scan look for the right thing in the wrong place — and answer "never executed" for something
  // that did.
  it("scans the Safe for a SafeTx from its claim block", async () => {
    const safe = "0x3333333333333333333333333333333333333333" as Address;
    const safeTxHash = `0x${"e".repeat(64)}` as Hex;
    const found = `0x${"b".repeat(64)}` as Hex;
    const seen: Array<{ address: Address; fromBlock: bigint }> = [];
    const publicClient = {
      getBlockNumber: async () => 500n,
      getLogs: async (args: { address: Address; fromBlock: bigint }) => {
        seen.push(args);
        return [
          { eventName: "ExecutionSuccess", args: { txHash: safeTxHash }, transactionHash: found },
        ];
      },
    } as unknown as PublicClient;

    const result = await createChainReader(publicClient).findSafeExecution(safe, safeTxHash, 400);

    expect(result).toEqual({ txHash: found, success: true });
    expect(seen[0].address).toBe(safe);
    // The claim block less the query's reorg margin — a number in, a bigint out. The margin's own
    // value is `findSafeExecutionByHash`'s business and is tested there; what matters here is that
    // the anchor arrived as a block height at all, rather than as `0n` or `NaN`.
    expect(seen[0].fromBlock).toBeLessThan(400n);
    expect(seen[0].fromBlock).toBeGreaterThan(300n);
  });

  describe("isKnown", () => {
    const withTransaction = (getTransaction: () => unknown) =>
      createChainReader({ getTransaction } as unknown as PublicClient);

    it("is true when the node has the tx (mempool or mined)", async () => {
      expect(await withTransaction(async () => ({ hash: "0xhash" })).isKnown("0xhash")).toBe(true);
    });

    it("is false when the node has never seen the tx", async () => {
      const reader = withTransaction(async () => {
        throw new TransactionNotFoundError({ hash: "0xhash" });
      });
      expect(await reader.isKnown("0xhash")).toBe(false);
    });

    // `false` here would let reconcile conclude the broadcast was rejected and re-drive a
    // subject whose tx is actually in flight.
    it("propagates an RPC failure rather than reporting the tx as unknown", async () => {
      const reader = withTransaction(async () => {
        throw new Error("429 rate limited");
      });
      await expect(reader.isKnown("0xhash")).rejects.toThrow("429 rate limited");
    });
  });

  describe("getSafeExecution", () => {
    const SAFE = "0x3333333333333333333333333333333333333333" as Address;
    const OTHER = "0x4444444444444444444444444444444444444444" as Address;
    const SAFE_TX = `0x${"e".repeat(64)}` as Hex;
    const OTHER_TX = `0x${"f".repeat(64)}` as Hex;

    // Both params are non-indexed, so a real Safe log is topic0 alone + the two values in `data`.
    const log = (
      eventName: "ExecutionSuccess" | "ExecutionFailure",
      txHash: Hex,
      address: Address = SAFE
    ) => ({
      address,
      topics: [toEventSelector(`${eventName}(bytes32,uint256)`)],
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [txHash, 0n]),
    });

    const readerFor = (status: "success" | "reverted", logs: unknown[]) =>
      createChainReader({
        getTransactionReceipt: async () => ({ status, logs }),
      } as unknown as PublicClient);

    it("returns success on a matching ExecutionSuccess from the Safe", async () => {
      const reader = readerFor("success", [log("ExecutionSuccess", SAFE_TX)]);
      expect(await reader.getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)).toBe("success");
    });

    it("returns failure on a matching ExecutionFailure from the Safe", async () => {
      const reader = readerFor("success", [log("ExecutionFailure", SAFE_TX)]);
      expect(await reader.getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)).toBe("failure");
    });

    it("returns reverted when the outer execTransaction reverted (status 0)", async () => {
      const reader = readerFor("reverted", []);
      expect(await reader.getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)).toBe("reverted");
    });

    it("returns no-event when the matching event is for a different SafeTx hash", async () => {
      const reader = readerFor("success", [log("ExecutionSuccess", OTHER_TX)]);
      expect(await reader.getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)).toBe("no-event");
    });

    it("ignores a same-signature event emitted by a different contract", async () => {
      const reader = readerFor("success", [log("ExecutionSuccess", SAFE_TX, OTHER)]);
      expect(await reader.getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)).toBe("no-event");
    });

    it("returns null when the receipt is not found yet", async () => {
      const publicClient = {
        getTransactionReceipt: async () => {
          throw new TransactionReceiptNotFoundError({ hash: "0xexec" });
        },
      } as unknown as PublicClient;
      expect(
        await createChainReader(publicClient).getSafeExecution("0xexec" as Hex, SAFE, SAFE_TX)
      ).toBeNull();
    });
  });
});

// The race unscoped reconcile introduced, and the reason `pending`-with-no-nonce is protected.
//
// `recordIntent` writes a `pending` row *before* the sender signs, and `markPending` fills in the
// nonce and hash only after signing returns — a window containing an RPC round trip. The
// arbitrageur runs two engines off one store, so while engine A is inside that window, engine B's
// reconcile sees A's row. Unguarded it reads "no nonce, no hash" as "never broadcast", marks it
// failed and frees the subject mid-send. Approvals make it worse: both engines claim them under one
// key, so they race the very same row.
describe("reconcilePending — an in-progress claim is not another engine's to resolve", () => {
  const claimed = (over: Partial<TxIntent> = {}): TxIntent =>
    ({
      id: "i1",
      chainId: 31337,
      target: TARGET,
      action: "approval",
      subject: TARGET,
      status: "pending",
      nonce: null,
      txHash: null,
      error: null,
      payload: null,
      payloadHash: null,
      safeEnvelope: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    }) as TxIntent;

  const runWith = async (intent: TxIntent, ageMs: number) => {
    const store = {
      reconcile: async () => [intent],
      transition: vi.fn(async () => {}),
    } as unknown as StateStore;
    await reconcilePending({
      store,
      reader: reader({ latest: 5, pending: 5 }),
      signer: SIGNER,
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => intent.updatedAt + ageMs,
    });
    return store.transition as ReturnType<typeof vi.fn>;
  };

  it("leaves a freshly claimed intent alone while its send is still in flight", async () => {
    const transition = await runWith(claimed(), 1_000);
    expect(transition).not.toHaveBeenCalled();
  });

  it("still resolves it once it is too old to be mid-send", async () => {
    const transition = await runWith(claimed(), UNKNOWN_TX_GRACE_MS + 1);
    expect(transition).toHaveBeenCalledWith("i1", "failed", expect.anything(), expect.anything());
  });

  // A send that failed is moved to `submitted` by `commit` before reconcile ever sees it, so the
  // guard cannot swallow one — that subject must still be freed promptly to be re-driven.
  it("does not protect a send that already failed", async () => {
    const transition = await runWith(claimed({ status: "submitted" }), 1_000);
    expect(transition).toHaveBeenCalledWith("i1", "failed", expect.anything(), expect.anything());
  });
});
