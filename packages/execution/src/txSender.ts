import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type Hex,
  InsufficientFundsError,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
} from "viem";

import { SubmitRejectedError } from "./submission";

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
// inferring from the nonce. This is the `./submission` seam wired onto the hot path; `submit`
// defaults to the public mempool.

/**
 * Who a bot's transactions come from, and on what chain — the keyless subset of what an engine used
 * to read off its `WalletClient`. In AUTO this is the bot's own signer; in MANUAL it is the
 * operator's wallet (the address whose balances/allowances the engine reads and whose `from` its
 * simulations use). An address and a number: **no key**, which is what lets a MANUAL engine hold no
 * `WalletClient` at all.
 */
export interface ExecutionIdentity {
  from: Address;
  chainId: number;
}

/** A contract call to sign — the engine-facing description of a tx. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Reserved nonce; omitted ⇒ viem fills it from the chain's `pending` count. */
  nonce?: number;
}

/** Encode a `ContractCall` to the `{ to, data }` a transaction carries. */
export function encodeCall(call: ContractCall): { to: Address; data: Hex } {
  return {
    to: call.address,
    data: encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as Parameters<typeof encodeFunctionData>[0]),
  };
}

/**
 * The transaction a MANUAL proposal asks an operator to sign, and the shape `hashPayload` commits
 * to. Every field is JSON-serializable (no `bigint`) — `value`/`gasLimit` are **decimal strings** —
 * because `@repo/persistence` stores it verbatim as `jsonb` and `operator-cli` renders it.
 *
 * `nonce` and fee fields are deliberately absent: they belong to whoever signs (the operator's
 * wallet fills them at broadcast), not to the bot proposing the call.
 */
export interface ProposedTx {
  chainId: number;
  to: Address;
  /** Encoded calldata. */
  data: Hex;
  /** Wei, as a decimal string (`"0"` today). */
  value: string;
  /** Gas limit hint, decimal string — advisory; the signer decides. */
  gasLimit?: string;
}

/** Bumps if the hash encoding ever changes, so an old proposal's hash stays interpretable. */
const PAYLOAD_HASH_VERSION = "aave-v4-bot-proposal-v1";

/**
 * Content hash of a proposal — the operator's out-of-band check (they compare it to the one shown in
 * their notification; `operator-cli` recomputes it from the persisted payload).
 *
 * It hashes a **fixed ABI byte layout of the semantic fields**, not a JSON serialization: the
 * payload is stored as `jsonb`, which reorders keys and drops an absent `gasLimit`, so a
 * string-of-the-object hash would not survive the round trip. `to` is normalized (`getAddress`) so
 * casing cannot change the hash; `value`/`gasLimit` are parsed from their decimal strings; an absent
 * `gasLimit` collapses to its documented `0` sentinel. Recomputing from a freshly-built payload or
 * from one read back out of the database yields the same hash.
 */
export function hashPayload(payload: ProposedTx): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        PAYLOAD_HASH_VERSION,
        BigInt(payload.chainId),
        getAddress(payload.to),
        payload.data,
        BigInt(payload.value),
        BigInt(payload.gasLimit ?? "0"),
      ]
    )
  );
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
   * Who these transactions come from, and on what chain. A sender *is* an identity — it signs with a
   * specific key on a specific chain — so the two travel together rather than being wired
   * separately. Callers read `sender.identity.from` for allowance/balance owners, the reconcile
   * signer, and the simulation `account`.
   */
  readonly identity: ExecutionIdentity;
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

// viem maintains this pattern across client implementations, but it is case-sensitive and anvil
// capitalises its message ("Insufficient funds for gas * price + value"), so testing the upstream
// regex literally would miss it. Reuse the source, drop the case sensitivity.
const INSUFFICIENT_FUNDS_MESSAGE = new RegExp(InsufficientFundsError.nodeMessage.source, "i");

/** Whether a node refused a broadcast because the sender cannot pay for it. */
function isInsufficientFunds(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    INSUFFICIENT_FUNDS_MESSAGE.test(error.details ?? "") ||
    INSUFFICIENT_FUNDS_MESSAGE.test(error.message)
  );
}

/**
 * The default `TxSender`: local signing + public-mempool broadcast. `submit` overrides where
 * the signed tx goes (e.g. a private relay — `./submission`'s `Submitter.send` fits as-is).
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
    // The sender's identity is intrinsic: its key is `walletClient.account`, its chain
    // `walletClient.chain`. A caller never has to supply it separately.
    identity: { from: walletClient.account.address, chainId: walletClient.chain.id },
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
      // From here on the tx may be on the wire: a throw is ambiguous, not a clean abort — with one
      // exception. A node that refuses the tx outright for insufficient funds never queued it and
      // never will, so nothing is in flight; and the cause is an unfunded key, an ops problem,
      // not the chain rejecting our trade. Which side of `broadcast` that surfaces on is purely a
      // property of the node: strict gas estimation (geth) rejects it in `prepare` above, lenient
      // estimation (anvil) prices it happily and only the broadcast refuses. Without this, whether
      // an empty gas tank trips the consecutive-failure breaker and halts a healthy bot would
      // depend on the RPC provider. `nonce too low` is deliberately NOT folded in here: there a tx
      // with that nonce really is on chain, so the caller must not treat it as a clean abort.
      try {
        await broadcast(signed.serialized);
      } catch (error) {
        // A submitter that declares the refusal outright is believed over any error-shape sniffing:
        // it knows its own protocol, where `isInsufficientFunds` only knows viem-against-a-node and
        // silently classifies everything else as ambiguous once a second backend exists.
        if (error instanceof SubmitRejectedError) throw new PreBroadcastError(error);
        if (isInsufficientFunds(error)) throw new PreBroadcastError(error);
        throw error;
      }
      // Prefer the locally-derived hash: it is what `onSigned` persisted, and it is what the
      // node returns anyway (same signed bytes).
      return signed.hash;
    },
  };
}
