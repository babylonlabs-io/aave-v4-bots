import {
  http,
  type Hex,
  TransactionNotFoundError,
  createPublicClient,
  createWalletClient,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { PreBroadcastError, type SignedTx, createTxSender, signContractCall } from "./index";

// Opt-in integration test against a **real node** (the unit tests in `execution.test.ts` run
// against a stubbed viem client). It runs only when an RPC url is configured; otherwise the whole
// block is skipped, so `pnpm test` stays offline by default.
//
//   anvil --silent &
//   EXECUTION_E2E_RPC_URL=http://127.0.0.1:8545 pnpm --filter @repo/execution test txSender.integration
//
// These cases need a real signer and a real node. `TxSender` derives the tx hash locally, as
// `keccak256(serialized)`, and hands it to `onSigned` BEFORE broadcasting; `reconcilePending` then
// trusts that hash to decide whether an in-flight intent is confirmed, dropped, or — via its
// `isKnown` probe — never accepted and safe to re-drive. So "the locally-derived hash is the hash
// the node assigns to these bytes" is load-bearing, and only a real node can confirm it: a stubbed
// `signTransaction` returns bytes the test itself chose, so asserting on their `keccak256` proves
// only `keccak256(x) === keccak256(x)`. A divergence here would have reconcile probe a hash the
// node has never heard of and re-drive a transaction that is genuinely in flight.

const RPC_URL = process.env.EXECUTION_E2E_RPC_URL;
const TIMEOUT = 30_000;

/** Anvil's default account 0 — a well-known test key, funded on a throwaway local chain. */
const FUNDED_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
/** Not one of anvil's pre-funded accounts, so its balance is genuinely zero. */
const UNFUNDED_KEY = `0x${"11".repeat(32)}` as Hex;

// Any call shape will do: the target has no code, so this is a well-formed no-op tx. What is under
// test is the sign → record → broadcast plumbing, not a contract.
const TARGET = "0x000000000000000000000000000000000000dEaD" as const;
const ABI = parseAbi(["function ping(uint256 value)"]);
const call = (nonce?: number) => ({
  address: TARGET,
  abi: ABI,
  functionName: "ping",
  args: [1n],
  ...(nonce !== undefined ? { nonce } : {}),
});

function clients(key: Hex) {
  const account = privateKeyToAccount(key);
  const transport = http(RPC_URL);
  return {
    account,
    publicClient: createPublicClient({ chain: anvil, transport }),
    walletClient: createWalletClient({ account, chain: anvil, transport }),
  };
}

describe.runIf(!!RPC_URL)("createTxSender (integration — real node)", () => {
  it(
    "derives the SAME tx hash the node assigns — the invariant reconcile rests on",
    async () => {
      const { publicClient, walletClient } = clients(FUNDED_KEY);
      const sender = createTxSender(publicClient, walletClient);

      let recorded: SignedTx | undefined;
      const returned = await sender.send(call(), async (tx) => {
        recorded = tx;
      });

      // Ask the node for the tx using the hash we computed locally, before it was broadcast.
      const onChain = await publicClient.getTransaction({ hash: recorded?.hash as Hex });

      expect(onChain.hash).toBe(recorded?.hash); // ← the whole point of the design
      expect(returned).toBe(recorded?.hash);
      expect(onChain.nonce).toBe(recorded?.nonce); // the recorded nonce is the one actually signed

      const receipt = await publicClient.waitForTransactionReceipt({ hash: onChain.hash });
      expect(receipt.status).toBe("success");
    },
    TIMEOUT
  );

  it(
    "the node does not know a signed tx until it is broadcast — isKnown's premise",
    async () => {
      const { publicClient, walletClient } = clients(FUNDED_KEY);

      // Sign WITHOUT broadcasting: precisely the state `onSigned` durably records.
      const signed = await signContractCall(walletClient, call());

      // reconcile's `isKnown` probe maps this throw to `false`. If a node instead *knew* a
      // merely-signed tx, the "not accepted ⇒ safe to re-drive" branch would be unsound.
      await expect(publicClient.getTransaction({ hash: signed.hash })).rejects.toBeInstanceOf(
        TransactionNotFoundError
      );

      // ...and once broadcast, that same hash IS known to the node.
      await publicClient.sendRawTransaction({ serializedTransaction: signed.serialized });
      await expect(publicClient.getTransaction({ hash: signed.hash })).resolves.toMatchObject({
        hash: signed.hash,
      });
    },
    TIMEOUT
  );

  it(
    "a node-rejected broadcast leaves a recorded hash the node never knows (isKnown ⇒ false)",
    async () => {
      // Half of the premise behind reconcile's `isKnown` branch: when the node REFUSES a broadcast,
      // the hash we durably recorded pre-broadcast is one the node does not have — so `isKnown`
      // answers `false` and reconcile learns nothing is on chain.
      //
      // The refusal here is a re-used (already mined) nonce, which pins that half alone. Selecting
      // the branch also requires the nonce slot to be free, and a mined nonce is by definition
      // taken — `engine/reconcile.test.ts` covers that combination against a scripted reader.
      const { account, publicClient, walletClient } = clients(FUNDED_KEY);
      const sender = createTxSender(publicClient, walletClient);

      const mined = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "latest",
      });
      const hash = await sender.send(call(mined));
      await publicClient.waitForTransactionReceipt({ hash });

      let recorded: SignedTx | undefined;
      await expect(
        sender.send(call(mined), async (tx) => {
          recorded = tx; // durably recorded pre-broadcast, as always
        })
      ).rejects.toThrow();

      expect(recorded?.hash).toMatch(/^0x[0-9a-f]{64}$/); // the hash WAS recorded...
      expect(recorded?.hash).not.toBe(hash);
      // ...and the node has never heard of it ⇒ `isKnown` is false ⇒ nothing is on chain.
      await expect(
        publicClient.getTransaction({ hash: recorded?.hash as Hex })
      ).rejects.toBeInstanceOf(TransactionNotFoundError);
    },
    TIMEOUT
  );

  it(
    "a refused broadcast is NOT a PreBroadcastError — the tx really was attempted",
    async () => {
      // Counterpart to the case below. The broadcast was attempted, so the engines must settle the
      // risk slot as a genuine failure (it feeds the breaker), not abandon it.
      const { account, publicClient, walletClient } = clients(FUNDED_KEY);
      const sender = createTxSender(publicClient, walletClient);

      const mined = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "latest",
      });
      await publicClient.waitForTransactionReceipt({ hash: await sender.send(call(mined)) });

      const error = await sender.send(call(mined)).catch((e) => e); // nonce already mined
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PreBroadcastError);
    },
    TIMEOUT
  );

  it(
    "an unfunded signer fails BEFORE broadcasting, as a PreBroadcastError",
    async () => {
      // A real node refuses to even price this tx, so it dies in `prepare` — nothing is signed and
      // nothing reaches the wire. The engines must settle it `abandoned`: it says nothing about the
      // chain rejecting our trades, and feeding it to the consecutive-failure breaker would let an
      // ops problem (an unfunded key, a flaky RPC) halt a healthy bot.
      const { account, publicClient, walletClient } = clients(UNFUNDED_KEY);
      expect(await publicClient.getBalance({ address: account.address })).toBe(0n);

      const sender = createTxSender(publicClient, walletClient);
      const onSigned = vi.fn();

      await expect(sender.send(call(), onSigned)).rejects.toBeInstanceOf(PreBroadcastError);

      expect(onSigned).not.toHaveBeenCalled(); // never got far enough to record anything
      expect(
        await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
      ).toBe(0); // and the nonce slot is untouched
    },
    TIMEOUT
  );

  it(
    "signs the reserved nonce when given one, and the chain's next nonce when not",
    async () => {
      const { account, publicClient, walletClient } = clients(FUNDED_KEY);
      const sender = createTxSender(publicClient, walletClient);

      const pending = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });

      // No reservation ⇒ viem fills the nonce from the chain. The record must carry THAT nonce: a
      // recorded `undefined` would leave reconcile unable to tell a broadcast tx from one that
      // never went out.
      let auto: SignedTx | undefined;
      await sender.send(call(), async (tx) => {
        auto = tx;
      });
      expect(auto?.nonce).toBe(pending);

      // With a reservation (the shared `NonceAllocator`'s), the signed tx must use exactly it.
      let reserved: SignedTx | undefined;
      await sender.send(call(pending + 1), async (tx) => {
        reserved = tx;
      });
      expect(reserved?.nonce).toBe(pending + 1);

      const onChain = await publicClient.getTransaction({ hash: reserved?.hash as Hex });
      expect(onChain.nonce).toBe(pending + 1);
    },
    TIMEOUT
  );
});
