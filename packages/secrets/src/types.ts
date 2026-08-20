// Secrets seam. A `SecretsProvider` resolves a secret *ref* (an env var name today, an AWS
// Secrets Manager id later) at boot — RPC keys, DB passwords, the Slack webhook, and the
// signer's key ref all flow through it, so no plaintext secret is hard-wired into a service.
// The signing key material itself lives in `@repo/signer`, not here — this only resolves the
// ref to a value. Adapters (`./env` in the barrel, `./aws`) implement this port.

export interface SecretsProvider {
  /**
   * Resolve a secret by ref; throws if missing/unset.
   *
   * @param label The configuration field the ref came from — `SIGNER_KEY_REF`, `SLACK_WEBHOOK_REF`.
   *        Errors identify the failure by this, because it is the thing an operator has to fix and
   *        the one part that is certainly not secret. A ref that turns out to be secret material
   *        (the value pasted where its name belongs) is refused without being echoed; see `./ref`.
   */
  get(ref: string, label: string): Promise<string>;
}
