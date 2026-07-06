// Secrets seam (proposal §12). A `SecretsProvider` resolves a secret *ref* (an env
// var name today, an AWS Secrets Manager id later) at boot — RPC keys, DB passwords,
// the Slack webhook, and the signer's key ref all flow through it, so no plaintext
// secret is hard-wired into a service. The signing key material itself lives in
// `@repo/signer`, not here — this only resolves the ref to a value.

export interface SecretsProvider {
  /** Resolve a secret by ref; throws if missing/unset. */
  get(ref: string): Promise<string>;
}

/**
 * `./env` adapter — the ref is an environment variable name. Empty strings count as
 * unset (matches `@repo/config`'s convention).
 */
export function createEnvSecrets(env: NodeJS.ProcessEnv = process.env): SecretsProvider {
  return {
    async get(ref) {
      const value = env[ref];
      if (value === undefined || value === "") {
        throw new Error(`secret "${ref}" is not set`);
      }
      return value;
    },
  };
}

/**
 * `./aws` adapter — stub. Resolves refs from AWS Secrets Manager (boot config + key
 * refs). Not implemented yet; wired only when a service runs against AWS.
 */
export function createAwsSecrets(): SecretsProvider {
  return {
    async get() {
      throw new Error("AWS Secrets Manager adapter not implemented (see refactor-002 Phase C)");
    },
  };
}
