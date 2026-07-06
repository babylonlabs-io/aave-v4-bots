import type { Account, Address, Hex } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";

// Signing seam (proposal §5.1, refactor-002 Phase C).
//
// A `Signer` is modelled as a viem `Account` — the abstraction viem itself uses for
// signing. Keeping it as an `Account` is what makes the local path **behavior-
// preserving**: a service builds its `WalletClient` with `signer.account`, and viem's
// `writeContract` already routes signing through the account (prepare →
// `account.signTransaction` → `sendRawTransaction`). A KMS-backed signer is therefore a
// drop-in — a custom `Account` whose `signTransaction` calls the HSM — with **no engine
// change** (see #25 for the real KMS adapter).
//
// **Decision D5:** local sends stay on viem's machinery (do not re-implement
// assemble→sign→broadcast). The explicit `signTransaction` → `Submitter.send` split
// (sign once, choose the broadcast path) ships below as a seam but is only wired onto the
// hot path in #21, where a private-relay `Submitter` actually needs it.

export interface Signer {
  /** The signer's address. */
  readonly address: Address;
  /** The viem account used to build a `WalletClient` (holds/backs the key). */
  readonly account: Account;
}

/** `./local` — an in-process key. Key material lives here, never in `@repo/engine`. */
export function createLocalSigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, account };
}

/**
 * `./kms` — stub. A production KMS/HSM signer: the address is derived off-chain from the
 * KMS public key; `signTransaction` (digest in / signature out) is done by the HSM.
 * Wireable but throws on sign until implemented (#25).
 */
export function createKmsSigner(config: { keyId: string; address: Address }): Signer {
  const notImplemented = async (): Promise<never> => {
    throw new Error(`KMS signer not implemented (keyId=${config.keyId}) — see issue #25`);
  };
  const account = toAccount({
    address: config.address,
    signMessage: notImplemented,
    signTransaction: notImplemented,
    signTypedData: notImplemented,
  });
  return { address: config.address, account };
}

// ── Broadcast seam (for #21) ───────────────────────────────────────────────────────

/** Where/how a signed tx is broadcast. Extended in #21 (private relay vs public). */
export interface SubmitPolicy {
  readonly relay?: "public";
}

export interface Submitter {
  /** Broadcast a serialized signed tx; returns the tx hash. */
  send(serializedTransaction: Hex, policy?: SubmitPolicy): Promise<Hex>;
}

/** Minimal structural view of the viem `PublicClient` broadcast method. */
export interface RawTxBroadcaster {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

/** `./public` — broadcast via the node's public mempool (today's behavior). */
export function createPublicSubmitter(client: RawTxBroadcaster): Submitter {
  return {
    send(serializedTransaction) {
      return client.sendRawTransaction({ serializedTransaction });
    },
  };
}
