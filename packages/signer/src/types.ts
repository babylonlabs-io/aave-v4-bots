import type { Account, Address } from "viem";

// Signing seam.
//
// A `Signer` is modelled as a viem `Account` — the abstraction viem itself uses for signing.
// Keeping it as an `Account` is what makes the local path **behavior-preserving**: a service
// builds its `WalletClient` with `signer.account`, and viem's `writeContract` already routes
// signing through the account (prepare → `account.signTransaction` → `sendRawTransaction`). A
// KMS-backed signer is therefore a drop-in — a custom `Account` whose `signTransaction` calls
// the HSM — with **no engine change** (see `./aws`).

export interface Signer {
  /** The signer's address. */
  readonly address: Address;
  /** The viem account used to build a `WalletClient` (holds/backs the key). */
  readonly account: Account;
}
