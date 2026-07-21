// Secrets seam. A `SecretsProvider` resolves a secret *ref* (an env
// var name today, an AWS Secrets Manager id later) at boot — RPC keys, DB passwords,
// the Slack webhook, and the signer's key ref all flow through it, so no plaintext
// secret is hard-wired into a service. The signing key material itself lives in
// `@repo/signer`, not here — this only resolves the ref to a value.

import { type AwsSecretsConfig, type SecretsSend, createAwsSecrets } from "./aws";

// `./aws` adapter — resolves refs from AWS Secrets Manager (implemented in `./aws.ts`).
export { type AwsSecretsConfig, type SecretsSend, createAwsSecrets };

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

/** The secrets backends a service can select at boot. */
export const SECRETS_SOURCES = ["env", "aws"] as const;
export type SecretsSource = (typeof SECRETS_SOURCES)[number];

export interface SecretsConfig {
  /** Which backend resolves refs. Defaults to `env` at the config layer. */
  source: SecretsSource;
  /** AWS region (only used by `aws`); omit to use the SDK's own resolution. */
  region?: string;
}

/**
 * Composition-root selector: build the `SecretsProvider` a service's config asks for.
 * The `aws` branch pulls in the AWS SDK; `env` stays dependency-free.
 */
export function createSecrets(config: SecretsConfig): SecretsProvider {
  switch (config.source) {
    case "env":
      return createEnvSecrets();
    case "aws":
      return createAwsSecrets({ region: config.region });
    default: {
      // Exhaustiveness guard — unreachable once `source` is a validated enum.
      const unknown: never = config.source;
      throw new Error(`unknown secrets source: ${String(unknown)}`);
    }
  }
}
