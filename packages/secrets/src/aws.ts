import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretsProvider } from "./types";

// `@repo/secrets` `./aws` adapter. Resolves a ref via `GetSecretValue`. A ref is a Secrets
// Manager name/ARN, optionally with a `#jsonKey` suffix that selects a single field from a
// JSON secret — e.g. `prod/liquidator/config#LIQUIDATOR_PRIVATE_KEY`. Only ref→value
// resolution lives here; the signing key itself is still owned by `@repo/signer`.

/** Minimal structural view of the AWS `SecretsManagerClient` — only the `send` we use. */
export interface SecretsClientLike {
  send(
    command: GetSecretValueCommand
  ): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}

export interface AwsSecretsConfig {
  /** AWS region; defaults to the SDK's own resolution (env/instance profile). */
  region?: string;
  /** Injectable client — for tests or custom credential/endpoint config. */
  client?: SecretsClientLike;
}

export function createAwsSecrets(config: AwsSecretsConfig = {}): SecretsProvider {
  const client: SecretsClientLike =
    config.client ??
    (new SecretsManagerClient(
      config.region ? { region: config.region } : {}
    ) as unknown as SecretsClientLike);

  return {
    async get(ref) {
      // Split an optional `#jsonKey` selector off the secret id. Secret names and ARNs
      // never contain `#`, so the first `#` is an unambiguous delimiter.
      const hashIndex = ref.indexOf("#");
      const secretId = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
      const jsonKey = hashIndex === -1 ? undefined : ref.slice(hashIndex + 1);

      let out: { SecretString?: string; SecretBinary?: Uint8Array };
      try {
        out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      } catch (error) {
        // `secretId` is the secret's name/ARN, not its value — safe to surface.
        throw new Error(
          `failed to fetch secret "${secretId}" from AWS Secrets Manager: ${(error as Error).message}`
        );
      }

      const raw =
        out.SecretString ??
        (out.SecretBinary ? Buffer.from(out.SecretBinary).toString("utf8") : undefined);
      if (raw === undefined) throw new Error(`secret "${secretId}" has no value`);

      // No selector → return the whole secret value verbatim (a plain-string secret).
      if (jsonKey === undefined) return raw;

      // `#jsonKey` → the secret must be a JSON object; return the named field. Error
      // messages name the secret and key but never echo the value.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`secret "${secretId}" is not valid JSON (needed to read key "${jsonKey}")`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          `secret "${secretId}" is not a JSON object (needed to read key "${jsonKey}")`
        );
      }
      const value = (parsed as Record<string, unknown>)[jsonKey];
      if (value === undefined) {
        throw new Error(`secret "${secretId}" has no JSON key "${jsonKey}"`);
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}
