import type { LocalAccount } from "viem";

// Signing seam.
//
// A `Signer` is modelled as a viem `Account` — the abstraction viem itself uses for signing.
// Keeping it as an `Account` is what makes the local path **behavior-preserving**: a service
// builds its `WalletClient` with `signer.account`, and viem's `writeContract` already routes
// signing through the account (prepare → `account.signTransaction` → `sendRawTransaction`). A
// KMS-backed signer is therefore a drop-in — a custom `Account` whose `signTransaction` calls
// the HSM — with **no engine change** (see `./aws`).

export interface Signer {
  /**
   * The viem account used to build a `WalletClient` (holds/backs the key).
   *
   * A `LocalAccount` rather than the wider `Account` union, which is what both branches actually
   * produce (`privateKeyToAccount`, and `toAccount` over the HSM). The union's JSON-RPC arm has no
   * `signTypedData`, so widening it here would deny callers a signing capability both real signers
   * have — the arbitrage router's EIP-712 authorization needs exactly that.
   */
  readonly account: LocalAccount;
}
