// Secrets seam. A `SecretsProvider` resolves a secret *ref* (an env var name today, an AWS
// Secrets Manager id later) at boot — RPC keys, DB passwords, the Slack webhook, and the
// signer's key ref all flow through it, so no plaintext secret is hard-wired into a service.
// The signing key material itself lives in `@repo/signer`, not here — this only resolves the
// ref to a value. Adapters (`./env` in the barrel, `./aws`) implement this port.

export interface SecretsProvider {
  /** Resolve a secret by ref; throws if missing/unset. */
  get(ref: string): Promise<string>;
}
