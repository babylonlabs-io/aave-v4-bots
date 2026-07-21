import { keccak256 } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ContractCall,
  type SignedTx,
  createNonceAllocator,
  createNonceLease,
  createTxSender,
  nextNonce,
  waitForReceipt,
  waitForReceiptWithTimeout,
} from "./index";

const HASH = "0xhash" as `0x${string}`;
const ADDR = "0xaddr" as `0x${string}`;
const SIGNER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

type PublicClientArg = Parameters<typeof waitForReceipt>[0];
type WalletClientArg = Parameters<typeof createTxSender>[1];

const SERIALIZED = "0xdeadbeef" as `0x${string}`;
/** The hash the node would report for `SERIALIZED` — derivable locally, before broadcast. */
const SIGNED_HASH = keccak256(SERIALIZED);

const CALL: ContractCall = {
  address: "0xcontract",
  abi: [
    {
      type: "function",
      name: "ping",
      inputs: [],
      outputs: [],
      stateMutability: "nonpayable",
    },
  ],
  functionName: "ping",
  args: [],
  nonce: 7,
};

/** Wallet/public client stubs recording the assemble → sign → broadcast sequence. */
function txClients(over: { sendRawTransaction?: () => Promise<`0x${string}`> } = {}) {
  const walletClient = {
    account: { address: SIGNER },
    chain: { id: 31337 },
    prepareTransactionRequest: vi.fn(async (req: { nonce?: number }) => ({
      ...req,
      nonce: req.nonce ?? 42, // viem fills it from the chain when the caller left it out
    })),
    signTransaction: vi.fn().mockResolvedValue(SERIALIZED),
  };
  const publicClient = {
    sendRawTransaction:
      over.sendRawTransaction === undefined
        ? vi.fn().mockResolvedValue(SIGNED_HASH)
        : vi.fn(over.sendRawTransaction),
  };
  return { walletClient, publicClient };
}

describe("@repo/execution", () => {
  describe("nextNonce", () => {
    it("reads the pending transaction count", async () => {
      const client = { getTransactionCount: vi.fn().mockResolvedValue(7) };
      const nonce = await nextNonce(client as unknown as PublicClientArg, ADDR);

      expect(nonce).toBe(7);
      expect(client.getTransactionCount).toHaveBeenCalledWith({
        address: ADDR,
        blockTag: "pending",
      });
    });
  });

  describe("waitForReceipt", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns the receipt when it resolves before the timeout", async () => {
      const receipt = { status: "success", blockNumber: 1n };
      const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) };

      // Do not advance timers: the timeout rejecter never fires.
      await expect(waitForReceipt(client as unknown as PublicClientArg, HASH, 5000)).resolves.toBe(
        receipt
      );
    });

    it("returns null when the timeout elapses first", async () => {
      const client = { waitForTransactionReceipt: () => new Promise(() => {}) }; // never resolves
      const promise = waitForReceipt(client as unknown as PublicClientArg, HASH, 5000);

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeNull();
    });

    it("re-throws non-timeout errors", async () => {
      const client = {
        waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("rpc down")),
      };
      await expect(
        waitForReceipt(client as unknown as PublicClientArg, HASH, 5000)
      ).rejects.toThrow("rpc down");
    });
  });

  describe("waitForReceiptWithTimeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("warns with the context prefix on timeout and returns null", async () => {
      const client = { waitForTransactionReceipt: () => new Promise(() => {}) };
      const promise = waitForReceiptWithTimeout(
        client as unknown as PublicClientArg,
        HASH,
        5000,
        "swap"
      );

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("swap "));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(HASH));
    });

    it("does not warn when the receipt arrives in time", async () => {
      const receipt = { status: "success" };
      const client = { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) };

      await expect(
        waitForReceiptWithTimeout(client as unknown as PublicClientArg, HASH, 5000)
      ).resolves.toBe(receipt);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("NonceAllocator", () => {
    const setup = () => {
      const lease = createNonceLease();
      return { alloc: createNonceAllocator(lease, SIGNER) };
    };

    it("reserve throws until seeded, then allocates from the chain seed", async () => {
      const { alloc } = setup();
      await expect(alloc.withNonce(async (n) => n)).rejects.toThrow(/not seeded/);

      await alloc.resync(() => Promise.resolve(10));
      expect(await alloc.withNonce(async (n) => n)).toBe(10);
      expect(await alloc.withNonce(async (n) => n)).toBe(11);
    });

    it("hands concurrent callers a gapless, duplicate-free sequence", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(0));

      const nonces = await Promise.all(
        Array.from({ length: 20 }, () => alloc.withNonce(async (n) => n))
      );

      expect(nonces).toEqual([...Array(20).keys()]); // 0..19, in call order
      expect(new Set(nonces).size).toBe(20); // no duplicates
    });

    it("does NOT reuse the nonce after a thrown send (no rollback)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      await expect(
        alloc.withNonce(async () => {
          throw new Error("ambiguous send");
        })
      ).rejects.toThrow("ambiguous send");

      // 5 is burned; the next send gets 6 (reclaim is the chain's job, not a rollback).
      expect(await alloc.withNonce(async (n) => n)).toBe(6);
    });

    it("a rejected section does not poison the lock chain", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(0));

      await expect(
        alloc.withNonce(async () => {
          throw new Error("x");
        })
      ).rejects.toThrow("x");
      expect(await alloc.withNonce(async (n) => n)).toBe(1);
    });

    it("serializes resync against an in-flight withNonce (no mid-flight rewind)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      const p1 = alloc.withNonce(async (n) => {
        await gate; // hold the lock at nonce 5
        return n;
      });
      const p2 = alloc.resync(() => Promise.resolve(100)); // queued behind p1
      const p3 = alloc.withNonce(async (n) => n); // queued behind resync

      release();
      expect(await p1).toBe(5);
      await p2;
      expect(await p3).toBe(100); // saw the resync, not a stale 6
    });

    it("reads the chain INSIDE the lock (no lost update vs an in-flight withNonce)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(5));

      let chain = 5;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      // In-flight send reserves 5 and, while the lock is held, "broadcasts" — advancing the
      // chain to 6. A resync whose read happened OUTSIDE the lock would capture the stale 5
      // and rewind; reading inside the lock sees 6.
      const p1 = alloc.withNonce(async (n) => {
        await gate;
        chain = 6;
        return n;
      });
      const p2 = alloc.resync(async () => chain);

      release();
      expect(await p1).toBe(5);
      await p2;
      expect(await alloc.withNonce(async (n) => n)).toBe(6); // not rewound to a stale 5
    });

    it("resync SET pulls the lease down to reclaim (Case C)", async () => {
      const { alloc } = setup();
      await alloc.resync(() => Promise.resolve(20));
      expect(await alloc.withNonce(async (n) => n)).toBe(20);

      await alloc.resync(() => Promise.resolve(10)); // chain shows 10 free (e.g. a dropped tx)
      expect(await alloc.withNonce(async (n) => n)).toBe(10);
    });
  });

  describe("createTxSender", () => {
    it("hands the signed hash to onSigned BEFORE broadcasting", async () => {
      const { walletClient, publicClient } = txClients();
      const order: string[] = [];
      publicClient.sendRawTransaction.mockImplementation(async () => {
        order.push("broadcast");
        return SIGNED_HASH;
      });
      const sender = createTxSender(
        publicClient as unknown as PublicClientArg,
        walletClient as unknown as WalletClientArg
      );

      let recorded: SignedTx | undefined;
      const hash = await sender.send(CALL, async (tx) => {
        order.push("onSigned");
        recorded = tx;
      });

      // The whole point: the hash is durable while the tx is still purely local.
      expect(order).toEqual(["onSigned", "broadcast"]);
      expect(recorded).toEqual({ hash: SIGNED_HASH, nonce: 7, serialized: SERIALIZED });
      expect(hash).toBe(SIGNED_HASH);
      expect(publicClient.sendRawTransaction).toHaveBeenCalledWith({
        serializedTransaction: SERIALIZED,
      });
    });

    it("does NOT broadcast when the durable record fails", async () => {
      const { walletClient, publicClient } = txClients();
      const sender = createTxSender(
        publicClient as unknown as PublicClientArg,
        walletClient as unknown as WalletClientArg
      );

      await expect(
        sender.send(CALL, async () => {
          throw new Error("store unavailable");
        })
      ).rejects.toThrow("store unavailable");

      // Nothing reached the chain, so the reserved nonce is still free — the caller may treat
      // this exactly like any other send failure.
      expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
    });

    it("reports the signed nonce when the caller does not reserve one", async () => {
      const { walletClient, publicClient } = txClients();
      const sender = createTxSender(
        publicClient as unknown as PublicClientArg,
        walletClient as unknown as WalletClientArg
      );

      let recorded: SignedTx | undefined;
      await sender.send({ ...CALL, nonce: undefined }, async (tx) => {
        recorded = tx;
      });

      // viem filled the nonce from the chain — the record must carry THAT, not `undefined`,
      // or reconcile cannot tell a broadcast tx from one that never went out.
      expect(recorded?.nonce).toBe(42);
    });

    it("surfaces an ambiguous broadcast failure after the hash is already durable", async () => {
      const { walletClient, publicClient } = txClients({
        sendRawTransaction: () => Promise.reject(new Error("rpc timeout")),
      });
      const sender = createTxSender(
        publicClient as unknown as PublicClientArg,
        walletClient as unknown as WalletClientArg
      );

      let recorded: SignedTx | undefined;
      await expect(
        sender.send(CALL, async (tx) => {
          recorded = tx;
        })
      ).rejects.toThrow("rpc timeout");

      // The tx may or may not have propagated — but its hash is recorded either way, so
      // reconcile resolves it by receipt lookup rather than inferring from the nonce.
      expect(recorded?.hash).toBe(SIGNED_HASH);
    });

    it("broadcasts through a custom submit (e.g. a private relay)", async () => {
      const { walletClient, publicClient } = txClients();
      const submit = vi.fn().mockResolvedValue(SIGNED_HASH);
      const sender = createTxSender(
        publicClient as unknown as PublicClientArg,
        walletClient as unknown as WalletClientArg,
        submit
      );

      await sender.send(CALL);

      expect(submit).toHaveBeenCalledWith(SERIALIZED);
      expect(publicClient.sendRawTransaction).not.toHaveBeenCalled();
    });
  });
});
