import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type AwsSignerConfig, type KmsSend, createAwsSigner } from "./aws";
import type { Signer } from "./types";

// `@repo/signer` public surface: the `Signer` port (`./types`), the `./local` adapter +
// selectors below, the `./aws` KMS adapter, and the broadcast `Submitter` seam. See `./types`
// for how the port is modelled.
//
// Local sends stay on viem's machinery (do not re-implement assemble→sign→broadcast).
// The explicit `signTransaction` → `Submitter.send` split (sign once, choose the broadcast
// path) ships below as a seam but is only wired onto the hot path once a non-default (e.g.
// private-relay) `Submitter` actually needs it.

export type { Signer } from "./types";

/** A 32-byte hex private key: `0x` + 64 hex chars. */
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * `./local` — an in-process key. Key material lives here, never in `@repo/engine`.
 *
 * The key shape is validated at this boundary (it used to be a zod schema in each
 * service's config). The error is deliberately **sanitized** — it never echoes the key
 * value — because a signer error can surface in logs.
 */
export function createLocalSigner(privateKey: string): Signer {
  if (!PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("invalid private key: expected 0x-prefixed 32-byte hex (66 chars)");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  return { address: account.address, account };
}

// `./aws` — an AWS KMS-backed signer (the key never leaves KMS; implemented in `./aws.ts`).
export { type KmsSend, type AwsSignerConfig, createAwsSigner };

// ── Composition-root selector ───────────────────────────────────────────────────────

/** The signer backends a service can select at boot. */
export const SIGNER_SOURCES = ["local", "aws"] as const;
export type SignerSource = (typeof SIGNER_SOURCES)[number];

/** AWS KMS selection — identical whether it lives in `Config` or the resolved input. */
type AwsSignerSelection = { source: "aws"; keyId: string; address?: Address; region?: string };

/**
 * How a service is **configured** to obtain its `Signer` (this is what lives in a service's
 * `Config`, env-derived, no key material).
 * - `local`: `keyRef` names where the key is stored; the composition root resolves it via
 *   `@repo/secrets` and passes the value in as a `ResolvedSignerConfig`.
 * - `aws`: the key lives in AWS KMS; `keyId` identifies it, nothing is resolved.
 */
export type SignerConfig = { source: "local"; keyRef: string } | AwsSignerSelection;

/**
 * The **resolved** input `createSigner` consumes. Same as `SignerConfig` except the local
 * key ref has already been resolved to the actual `privateKey` by the caller — so
 * `@repo/signer` stays free of any secrets/resolver concept.
 */
export type ResolvedSignerConfig = { source: "local"; privateKey: string } | AwsSignerSelection;

/**
 * Turn raw (already string-validated) env fields into a `SignerConfig`, applying the
 * cross-field rules a flat zod schema can't: `aws` requires a `keyId`, and `local`
 * defaults its `keyRef` to the service's conventional key var. Throws (fail-fast at boot)
 * on an inconsistent combination.
 */
export function buildSignerConfig(input: {
  source: SignerSource;
  /** `local`: the ref to resolve the key from; defaults to `defaultKeyRef`. */
  keyRef?: string;
  /** `local`: the ref used when `keyRef` is unset (e.g. `LIQUIDATOR_PRIVATE_KEY`). */
  defaultKeyRef: string;
  /** `aws`: the KMS key id/ARN/alias. */
  kmsKeyId?: string;
  /** `aws`: optional expected address (boot fails if it mismatches the key). */
  address?: Address;
  /** `aws`: optional AWS region. */
  region?: string;
}): SignerConfig {
  if (input.source === "aws") {
    if (!input.kmsKeyId) {
      throw new Error("SIGNER_SOURCE=aws requires KMS_KEY_ID to be set");
    }
    return { source: "aws", keyId: input.kmsKeyId, address: input.address, region: input.region };
  }
  return { source: "local", keyRef: input.keyRef ?? input.defaultKeyRef };
}

/**
 * Build the `Signer` from a **resolved** config. The caller (composition root) resolves a
 * `local` key ref via `@repo/secrets` and passes the key in — so the key is never a
 * plaintext `Config` field, and `@repo/signer` needs no secrets dependency. `aws` never
 * touches key material. Async because the KMS path derives its address at boot.
 */
export async function createSigner(config: ResolvedSignerConfig): Promise<Signer> {
  switch (config.source) {
    case "local":
      return createLocalSigner(config.privateKey);
    case "aws":
      return createAwsSigner({
        keyId: config.keyId,
        address: config.address,
        region: config.region,
      });
    default: {
      // Exhaustiveness guard — unreachable once `source` is a validated enum.
      const unknown: never = config;
      throw new Error(`unknown signer source: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Composition-root convenience: turn a `SignerConfig` into a `Signer`, resolving the
 * `local` key ref via the supplied resolver (typically a `SecretsProvider`'s `get`) and
 * handing the *value* to `createSigner`. `aws` resolves nothing. Keeps the local
 * ref→value→signer dance in one place instead of repeated in every service boot, without
 * giving `@repo/signer` a `@repo/secrets` dependency (the resolver is a plain callback).
 */
export async function resolveSigner(
  config: SignerConfig,
  resolveRef: (ref: string) => Promise<string>
): Promise<Signer> {
  if (config.source === "local") {
    return createSigner({ source: "local", privateKey: await resolveRef(config.keyRef) });
  }
  return createSigner(config);
}

// ── Broadcast seam ───────────────────────────────────────────────────────────────

/** Where/how a signed tx is broadcast. Extended later (private relay vs public). */
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
