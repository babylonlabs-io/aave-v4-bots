// `@repo/secrets` public surface: the `SecretsProvider` port (`./types`), the `./env` adapter
// + selector below, and the `./aws` adapter. See `./types` for the seam's rationale.

import { type AwsSecretsConfig, type SecretsClientLike, createAwsSecrets } from "./aws";
import type { SecretsProvider } from "./types";

export type { SecretsProvider } from "./types";
// `./aws` adapter — resolves refs from AWS Secrets Manager (implemented in `./aws.ts`).
export { type AwsSecretsConfig, type SecretsClientLike, createAwsSecrets };

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
