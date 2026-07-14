import { createLogger } from "@repo/logger";
import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeFunctionData,
  keccak256,
} from "viem";

const logger = createLogger();

// Transaction execution primitives — nonce sourcing and receipt-waiting. The
// service keeps its own send loop / nonce sequencing / retry orchestration; these
// are the shared building blocks.

type Receipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

/** Nonce to use for the next transaction from `address` (includes pending txs). */
export function nextNonce(client: PublicClient, address: Address): Promise<number> {
  return client.getTransactionCount({ address, blockTag: "pending" });
}

// ── Shared nonce authority ────────────────────────────────────────────────────────────
//
// One signer, possibly two engines (arbitrageur runs both) polling concurrently. A single
// `NonceAllocator` — shared across engines — is the sole nonce owner. Correctness rests on two
// things: an in-process **mutex** (so two engines never reserve the same nonce) and **re-seeding
// from the chain** (`resync`), which makes the chain the source of truth across restarts. Intent
// idempotency is a separate concern and lives in `@repo/persistence`.
//
// **No rollback:** a thrown `send` does not prove the tx was not broadcast (an RPC timeout can
// fire after the node accepted it), so the reserved nonce is NOT reused within the cycle; the
// next cycle's `resync` reclaims it from the chain only if the chain shows it free.

/**
 * Where the next-nonce counter lives. In-memory for the single-instance cut; a DB-backed,
 * row-locked implementation is the seam for a future multi-process deployment. `reserve`
 * requires the lease to have been seeded (via `set`/the allocator's `resync`) — throws otherwise.
 */
export interface NonceLease {
  /** Return the current next-nonce for `signer` and advance the counter by one. */
  reserve(signer: Address): Promise<number>;
  /** Set the next-nonce for `signer` (seed at boot / re-seed each cycle / reclaim). */
  set(signer: Address, value: number): Promise<void>;
}

/** Default in-memory `NonceLease` (per-signer counter). */
export function createNonceLease(): NonceLease {
  const next = new Map<string, number>();
  return {
    async reserve(signer) {
      const key = signer.toLowerCase();
      const value = next.get(key);
      if (value === undefined) {
        throw new Error(`nonce lease for ${signer} is not seeded (resync first)`);
      }
      next.set(key, value + 1);
      return value;
    },
    async set(signer, value) {
      next.set(signer.toLowerCase(), value);
    },
  };
}

export interface NonceAllocator {
  /**
   * Reserve the next nonce and run `send` under the per-signer lock. `send(nonce)` MUST do
   * only the durable pre-broadcast recording (if any) + the broadcast, returning the hash —
   * no receipt wait (it holds the lock). On throw the outcome is UNKNOWN: the nonce is not
   * reused this cycle and the error propagates (the caller stops sending); the next cycle's
   * `resync` reclaims it from the chain iff it is free.
   */
  withNonce<T>(send: (nonce: number) => Promise<T>): Promise<T>;
  /**
   * Re-align the lease to the chain's `pending` nonce (SET). `readChainNonce` is invoked
   * **inside** the lock — this is essential: reading the chain outside the lock and passing a
   * value in would let a concurrent `withNonce` advance the lease between the read and the
   * SET, rewinding it and reusing a nonce. Call once at boot and at each cycle start.
   */
  resync(readChainNonce: () => Promise<number>): Promise<void>;
}

/**
 * Build the shared nonce authority for `signer`. The lock is a promise chain: each critical
 * section (`withNonce` body or `resync`) awaits the previous one, so reserve/broadcast/resync
 * never interleave and a rejection does not poison later sections.
 */
export function createNonceAllocator(lease: NonceLease, signer: Address): NonceAllocator {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    // Swallow rejections for the chain only — the returned promise keeps the real error.
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  return {
    withNonce(send) {
      return exclusive(async () => {
        const nonce = await lease.reserve(signer);
        return send(nonce); // no rollback: an error propagates; the nonce is reclaimed via resync
      });
    },
    resync(readChainNonce) {
      return exclusive(async () => {
        // Read the chain WHILE holding the lock, so the SET reflects any broadcast that just
        // completed (no lost update against a concurrent `withNonce`).
        const chainPendingNonce = await readChainNonce();
        await lease.set(signer, chainPendingNonce);
      });
    },
  };
}

// ── Durable-hash sending (sign → record → broadcast) ──────────────────────────────────
//
// `writeContract` assembles, signs and broadcasts in one step, so the tx hash only exists
// *after* the tx is already on the wire. That leaves an unclosable window: if the caller
// crashes (or its store write fails) between broadcast and recording the hash, a live tx
// exists that no record points at — and reconcile, seeing a mined nonce with no hash, has to
// guess. Splitting the step lets the hash be recorded while the tx is still purely local:
//
//   prepare → sign (hash exists here, nothing broadcast) → `onSigned` (durable) → broadcast
//
// So the two failure points are now both safe. If `onSigned` throws, nothing was broadcast and
// the reserved nonce is free (the next `resync` reclaims it). If the *broadcast* is ambiguous,
// the hash is already durable, so reconcile resolves the intent by receipt lookup instead of
// inferring from the nonce. This is the `Submitter` seam in `@repo/signer` wired onto the hot
// path; `submit` defaults to the public mempool.

/** A contract call to sign — the engine-facing description of a tx. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Reserved nonce; omitted ⇒ viem fills it from the chain's `pending` count. */
  nonce?: number;
}

/** A locally-signed tx: its hash is known before anything is broadcast. */
export interface SignedTx {
  hash: Hex;
  /** The nonce actually signed over (the reserved one, or the chain-filled one). */
  nonce: number;
  serialized: Hex;
}

export interface TxSender {
  /**
   * Sign `call` locally, hand the resulting `SignedTx` to `onSigned` (the durable
   * pre-broadcast record), then broadcast. A throwing `onSigned` aborts the send — nothing
   * reaches the chain — so the caller may treat it as a plain send failure.
   */
  send(call: ContractCall, onSigned?: (tx: SignedTx) => Promise<void>): Promise<Hex>;
}

/**
 * Sign `call` without broadcasting it. The hash is derived from the signed payload (keccak256
 * of the serialized tx) — the same hash the node will report — so it is durable-recordable
 * before the tx exists on chain.
 */
export async function signContractCall(
  walletClient: WalletClient<Transport, Chain, Account>,
  call: ContractCall
): Promise<SignedTx> {
  const request = await walletClient.prepareTransactionRequest({
    to: call.address,
    data: encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as Parameters<typeof encodeFunctionData>[0]),
    ...(call.nonce !== undefined ? { nonce: call.nonce } : {}),
    account: walletClient.account,
    chain: walletClient.chain,
  });
  const serialized = await walletClient.signTransaction(
    request as Parameters<typeof walletClient.signTransaction>[0]
  );
  return { hash: keccak256(serialized), nonce: request.nonce, serialized };
}

/**
 * A send that failed **before** the tx reached the wire — while preparing, while signing, or
 * inside `onSigned` (the durable record). Nothing is on chain and the reserved nonce is still
 * free, so this is categorically not "the chain rejected us".
 *
 * Callers must be able to tell it apart from a failed *broadcast*, which is ambiguous (the tx
 * may be in flight). A risk gate in particular must settle this as `abandoned` — feeding it to
 * the consecutive-failure breaker would let a database blip or an RPC hiccup halt the bot as if
 * the chain were refusing its transactions.
 */
export class PreBroadcastError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PreBroadcastError";
  }
}

/**
 * The default `TxSender`: local signing + public-mempool broadcast. `submit` overrides where
 * the signed tx goes (e.g. a private relay — `@repo/signer`'s `Submitter.send` fits as-is).
 */
export function createTxSender(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  submit?: (serializedTransaction: Hex) => Promise<Hex>
): TxSender {
  const broadcast =
    submit ??
    ((serializedTransaction: Hex) => publicClient.sendRawTransaction({ serializedTransaction }));
  return {
    async send(call, onSigned) {
      let signed: SignedTx;
      try {
        signed = await signContractCall(walletClient, call);
        // Durable BEFORE the tx can exist on chain.
        await onSigned?.(signed);
      } catch (error) {
        // Nothing was broadcast — say so, rather than letting the caller assume the worst.
        throw new PreBroadcastError(error);
      }
      // From here on the tx may be on the wire: a throw is ambiguous, not a clean abort.
      await broadcast(signed.serialized);
      // Prefer the locally-derived hash: it is what `onSigned` persisted, and it is what the
      // node returns anyway (same signed bytes).
      return signed.hash;
    },
  };
}

const RECEIPT_TIMEOUT_MESSAGE = "Transaction receipt timeout";

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(RECEIPT_TIMEOUT_MESSAGE)), ms);
  });
}

/**
 * Wait for `hash`'s receipt, returning `null` if `timeoutMs` elapses first rather
 * than hanging. Non-timeout errors are re-thrown.
 */
export async function waitForReceipt(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number
): Promise<Receipt | null> {
  try {
    return await Promise.race([client.waitForTransactionReceipt({ hash }), rejectAfter(timeoutMs)]);
  } catch (error) {
    if (error instanceof Error && error.message === RECEIPT_TIMEOUT_MESSAGE) {
      return null;
    }
    throw error;
  }
}

/**
 * `waitForReceipt` that also logs a warning on timeout (prefixed with an
 * optional `context` label, matching `@repo/chain`'s `withRetry`). Returns `null` on
 * timeout, re-throws other errors.
 */
export async function waitForReceiptWithTimeout(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number,
  context?: string
): Promise<Receipt | null> {
  const receipt = await waitForReceipt(client, hash, timeoutMs);
  if (receipt === null) {
    const prefix = context ? `${context} ` : "";
    logger.warn(`${prefix}Timeout waiting for transaction ${hash} after ${timeoutMs}ms`);
  }
  return receipt;
}
