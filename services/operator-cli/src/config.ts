import { addressSchema, parseEnv, urlSchema } from "@repo/config";
import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import type { Address } from "viem";
import { z } from "zod";

// `operator-cli` config. Unlike a bot, this tool DOES hold signing keys — it is the operator's own
// process, deliberately separate from the keyless bot. `eoa` custody resolves one operator key;
// `safe` resolves the Safe owners' keys (for the automatable broadcast path) — both from *secret
// references* via `@repo/secrets`, never inline. The custody model (`MANUAL_EXECUTOR_KIND`) and the
// executor address must match the bot's, so the CLI signs from the identity the proposal was
// simulated against.

export interface Config {
  rpcUrl: string;
  /** MANUAL requires persistence — proposals live in the shared StateStore. */
  persistence: PersistenceConfig;
  secrets: SecretsConfig;
  /** The account the proposal was simulated from — an EOA, or the Safe in `safe` custody. */
  executorAddress: Address;
  executorKind: "eoa" | "safe";
  /** `eoa`: the operator key's secret ref. `safe`: the owner keys' secret refs (>= threshold). */
  operatorKeyRef?: string;
  safeOwnerKeyRefs: string[];
  /** Safe contract version for the EIP-712 domain (v1.3.0+). */
  safeVersion: string;
}

const envSchema = z.object({
  CLIENT_RPC_URL: urlSchema,
  DATABASE_URL: z.string().min(1),
  PERSISTENCE_SCHEMA: z.string().min(1).optional(),
  SECRETS_PROVIDER: z.enum(["env", "aws"]).optional().default("env"),
  AWS_REGION: z.string().min(1).optional(),

  MANUAL_EXECUTOR_ADDRESS: addressSchema,
  MANUAL_EXECUTOR_KIND: z.enum(["eoa", "safe"]),

  // eoa custody — the operator's key ref.
  OPERATOR_KEY_REF: z.string().min(1).optional(),
  // safe custody — the owner key refs (comma-separated), used by the automatable `broadcast` path.
  SAFE_OWNER_KEY_REFS: z.string().optional(),
  SAFE_VERSION: z.string().min(1).optional().default("1.4.1"),
});

/** Split a comma-separated secret-ref list, trimming blanks. */
function refList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  const env = parseEnv(envSchema);

  const kind = env.MANUAL_EXECUTOR_KIND;
  // No key is required to run the CLI: the production flow is keyless — `list`/`show`/`claim`/`confirm`
  // hold no key (the operator signs in their own tooling). Only `broadcast` (the local-key automation
  // path) needs one, and it fails at call time if the ref is absent.

  return {
    rpcUrl: env.CLIENT_RPC_URL,
    // DATABASE_URL is required above; these two builders are trivial shapes, inlined to avoid coupling
    // the CLI's minimal env to `@repo/config`'s full `RuntimeEnv` (notifier/signer fields it lacks).
    persistence: { connectionString: env.DATABASE_URL, schema: env.PERSISTENCE_SCHEMA },
    secrets: { source: env.SECRETS_PROVIDER, region: env.AWS_REGION },
    executorAddress: env.MANUAL_EXECUTOR_ADDRESS as Address,
    executorKind: kind,
    operatorKeyRef: env.OPERATOR_KEY_REF,
    safeOwnerKeyRefs: refList(env.SAFE_OWNER_KEY_REFS),
    safeVersion: env.SAFE_VERSION,
  };
}
