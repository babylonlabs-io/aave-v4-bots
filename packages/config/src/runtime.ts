import type { NotifierSettings } from "@repo/notifications";
import type { PersistenceConfig } from "@repo/persistence";
import type { SecretsConfig } from "@repo/secrets";
import { z } from "zod";

import {
  addressSchema,
  intInRangeSchema,
  nonNegativeIntSchema,
  positiveBigIntSchema,
  urlSchema,
} from "./schemas";

/** A 0x-prefixed address. `@repo/config` avoids a `viem` dependency, so it names the shape itself. */
type Hex40 = `0x${string}`;

// Env fields every bot service shares: where secrets come from, how the signer is obtained, and
// whether crash-safety persistence is on. Declared once so the two services cannot drift.
//
// The **signer** projection deliberately stays in each service: `buildSignerConfig` is a value
// import from `@repo/signer`, and pulling it in here would give every `@repo/config` consumer a
// runtime dependency on the AWS KMS SDK.
//
// Everything this module imports from a sibling package is `import type`, erased at compile time,
// so `@repo/{persistence,secrets,risk}` are **devDependencies** of `@repo/config`: they name the
// shapes these builders return without putting those packages in any consumer's runtime graph.

/**
 * Ceiling on the two block counts that make up the private-submission nonce fence.
 *
 * Roughly a day of Ethereum blocks — orders of magnitude above any real relay retry window (Protect
 * offers a transaction for ~25 blocks) and still finite. The fence is the *only* thing that ever
 * frees the nonce of a privately-submitted transaction the relay has dropped, so a horizon set to a
 * number nobody meant does not read as a big number anywhere downstream: it reads as a nonce that
 * never comes back, with every later send from either engine queued behind it. `liveness.ts` bounds
 * the relay's *declared* deadline for the same reason (`RELAY_HORIZON_TRUST_MULTIPLE`); this bounds
 * the operator's declared one.
 */
const MAX_HORIZON_BLOCKS = 7200;

/**
 * Ceiling on the relay's two network deadlines. Both are per-call timeouts inside a poll cycle, and
 * the submit one is awaited under the nonce allocator's lock — so an over-long value does not slow
 * one request, it stalls every later send and resync in the process. Two minutes is far past any
 * healthy relay round-trip.
 */
const MAX_RELAY_TIMEOUT_MS = 120_000;

export const runtimeEnvFields = {
  // Signer + secrets source selection. Defaults preserve today's behavior: a local signer whose
  // key is read from the service's own `*_PRIVATE_KEY` env var.
  SECRETS_PROVIDER: z.enum(["env", "aws"]).optional().default("env"),
  SIGNER_SOURCE: z.enum(["local", "aws"]).optional().default("local"),
  /** Where the key lives — an env-var name, or an AWS secret id. Never the key itself. */
  SIGNER_KEY_REF: z.string().min(1).optional(),
  KMS_KEY_ID: z.string().min(1).optional(),
  SIGNER_ADDRESS: addressSchema.optional(),
  AWS_REGION: z.string().min(1).optional(),

  /**
   * Where a signed transaction is broadcast. `public` (default) is today's behaviour — the node's
   * mempool. `flashbots-protect` submits privately, so the transaction is not visible to
   * front-runners; see `docs/design-026-private-relay-submission.md` for what that costs elsewhere.
   */
  SUBMITTER: z.enum(["public", "flashbots-protect"]).optional().default("public"),
  /** Protect RPC the signed transaction is sent to. */
  FLASHBOTS_PROTECT_URL: urlSchema.optional(),
  /** Where a private transaction's status (and its `maxBlockNumber` horizon) is read from. */
  FLASHBOTS_STATUS_URL: urlSchema.optional().default("https://protect.flashbots.net"),
  /**
   * Floor for the priority fee on a privately-submitted transaction, in wei. Required in private
   * mode and deliberately has no default — see `buildSubmitterConfig`.
   */
  PRIVATE_MIN_PRIORITY_FEE_WEI: positiveBigIntSchema.optional(),
  /**
   * The relay's retry window, in blocks — how long it may keep offering a transaction to builders.
   * Used when the relay does not tell us a transaction's own deadline. Protect's is ~25 blocks;
   * declare whatever the configured relay actually uses.
   */
  PRIVATE_RELAY_HORIZON_BLOCKS: intInRangeSchema(
    1,
    MAX_HORIZON_BLOCKS,
    "the relay's retry window, not an open-ended fence"
  )
    .optional()
    .default("25"),
  /** Blocks past a transaction's horizon before its nonce may be reclaimed — reorg headroom. */
  PRIVATE_RECLAIM_MARGIN_BLOCKS: intInRangeSchema(1, MAX_HORIZON_BLOCKS, "reorg headroom")
    .optional()
    .default("3"),
  /**
   * How long a submit to the relay may take before it is abandoned as ambiguous.
   *
   * Lower it if you run a faster loop than the default `POLLING_INTERVAL_MS`: the submit is awaited
   * under the nonce lock, so it has to finish inside a cycle with room to spare for the rest of it.
   */
  PRIVATE_SUBMIT_TIMEOUT_MS: intInRangeSchema(
    1,
    MAX_RELAY_TIMEOUT_MS,
    "it is awaited under the nonce lock"
  )
    .optional()
    .default("8000"),
  /** How long a relay status probe may take before it is treated as a failed probe. */
  PRIVATE_STATUS_TIMEOUT_MS: intInRangeSchema(1, MAX_RELAY_TIMEOUT_MS).optional().default("2000"),

  /** Enables the Postgres StateStore. Unset ⇒ no persistence (in-memory nonce sequencing). */
  DATABASE_URL: z.string().min(1).optional(),
  /** Isolates the bot's tables from the indexer's. */
  PERSISTENCE_SCHEMA: z.string().min(1).optional(),

  /** Outbound alerts. `none` (default) logs only; `slack` also posts to a webhook. */
  NOTIFIER: z.enum(["none", "slack"]).optional().default("none"),
  /**
   * Secret *reference* for the Slack webhook URL — an env-var name or an AWS secret id, never the
   * URL itself. Resolved through `@repo/secrets` at boot, like `SIGNER_KEY_REF`. Required when
   * `NOTIFIER=slack`.
   */
  SLACK_WEBHOOK_REF: z.string().min(1).optional(),

  /**
   * How the service executes. `AUTO` (default) signs + broadcasts (the bot holds the key).
   * `MANUAL` is **keyless**: it persists a content-hashed proposal + notifies an operator who
   * signs with their own wallet — no private key, `WalletClient`, or nonce anywhere in the process.
   */
  EXECUTION_MODE: z.enum(["AUTO", "MANUAL"]).optional().default("AUTO"),
  /**
   * The account that will broadcast the proposals — the identity whose balances/allowances the engine
   * reads and whose `from` its simulations use. An address, never a key. In `safe` custody this is the
   * Safe itself (the `msg.sender` of the inner call). Required in MANUAL.
   */
  MANUAL_EXECUTOR_ADDRESS: addressSchema.optional(),
  /**
   * The operator's custody model — `eoa` (a plain account: hardware wallet or a local dev key) or
   * `safe` (a Safe{Wallet} multisig). Required in MANUAL, because it changes both how a proposal is
   * broadcast and how it is confirmed (a Safe's inner success is an event, not the tx receipt). No
   * default: a silent `eoa` would mis-confirm a Safe deployment.
   */
  MANUAL_EXECUTOR_KIND: z.enum(["eoa", "safe"]).optional(),
  /**
   * How long (ms) an un-actioned MANUAL proposal lives before it's swept to `expired` — freeing its
   * subject to be re-proposed (and re-notified). `0` disables expiry. Default 3 hours. MANUAL only.
   */
  MANUAL_INTENT_TTL_MS: nonNegativeIntSchema.optional().default("10800000"),
  /**
   * How long (ms) a `claimed` or `submitted` MANUAL intent may sit before the bot emits an
   * `intent-stuck` alert — an abandoned claim or a dropped broadcast the operator must resolve. `0`
   * disables the check. Default 1 hour. MANUAL only.
   */
  MANUAL_INTENT_STUCK_MS: nonNegativeIntSchema.optional().default("3600000"),
} as const;

/** The env shape the builders below consume. */
export interface RuntimeEnv {
  SECRETS_PROVIDER: "env" | "aws";
  AWS_REGION?: string;
  DATABASE_URL?: string;
  PERSISTENCE_SCHEMA?: string;
  NOTIFIER: "none" | "slack";
  SLACK_WEBHOOK_REF?: string;
}

/**
 * The env subset `buildExecutionConfig` reads. Kept separate from `RuntimeEnv` so the mode's
 * cross-field validation (it inspects the signer + persistence vars) doesn't force every other
 * builder's callers to supply signer fields.
 */
export interface ExecutionEnv extends SubmitterEnv {
  EXECUTION_MODE: "AUTO" | "MANUAL";
  // Address vars stay `string` here — the `addressSchema` regex validates the format but zod infers
  // `string`; `buildExecutionConfig` narrows to `Hex40` on the way out.
  MANUAL_EXECUTOR_ADDRESS?: string;
  MANUAL_EXECUTOR_KIND?: "eoa" | "safe";
  MANUAL_INTENT_TTL_MS: string;
  MANUAL_INTENT_STUCK_MS: string;
  DATABASE_URL?: string;
  SIGNER_SOURCE: "local" | "aws";
  SIGNER_KEY_REF?: string;
  KMS_KEY_ID?: string;
  SIGNER_ADDRESS?: string;
}

/**
 * How a service executes. A discriminated union so each mode *carries* exactly what it needs — the
 * composition root reads them without a re-check, and neither arm has fields the other would make
 * meaningless.
 *
 * `submitter` sits on the AUTO arm because submission is only a decision when the bot broadcasts.
 * MANUAL is keyless: an operator signs and sends with their own wallet, so where the bytes go is
 * theirs to choose. Nesting it makes that unrepresentable rather than merely documented — otherwise
 * `MANUAL` + `flashbots-protect` type-checks and boots, builds a relay submitter that never sends
 * anything, and leaves an operator believing they have MEV protection they do not have.
 */
export type ExecutionSettings =
  | { mode: "AUTO"; submitter: SubmitterSettings }
  | {
      mode: "MANUAL";
      /** The account whose balances/allowances the engine reads and whose `from` it simulates from —
       *  an EOA, or the Safe itself in `safe` custody. */
      manualExecutorAddress: Hex40;
      /** The operator's custody model. Drives the operator-cli's signer and, critically, how the bot's
       *  reconcile confirms an intent — `safe` resolves by the Safe's `Execution{Success,Failure}`
       *  event, `eoa` by the tx receipt status. */
      executorKind: "eoa" | "safe";
      /** Sweep an un-actioned proposal to `expired` after this many ms (`0` disables). */
      intentTtlMs: number;
      /** Alert (`intent-stuck`) on a claimed/submitted intent older than this many ms (`0` disables). */
      intentStuckMs: number;
    };

// `NotifierSettings` is owned by `@repo/notifications` (the consumer, `buildNotifier`), imported above
// and re-exported here so a service reads it off `@repo/config` like every other boot-plan type. One
// definition, so `buildNotifierConfig`'s output and `buildNotifier`'s input can never drift apart.
export type { NotifierSettings };

/**
 * Project the notifier env into a service's boot plan. Rejects `slack` with no webhook ref here —
 * at config time — rather than letting the notifier factory fail later, so a misconfigured alerting
 * setup stops the bot at startup instead of at the first alert it fails to send.
 */
export function buildNotifierConfig(env: RuntimeEnv): NotifierSettings {
  if (env.NOTIFIER === "slack" && !env.SLACK_WEBHOOK_REF) {
    throw new Error("NOTIFIER=slack requires SLACK_WEBHOOK_REF (a secret reference)");
  }
  return { source: env.NOTIFIER, webhookRef: env.SLACK_WEBHOOK_REF };
}

/**
 * The env subset `buildSubmitterConfig` reads. `DATABASE_URL` is here because private submission
 * *requires* a store, for the same reason MANUAL does — see below.
 */
export interface SubmitterEnv {
  SUBMITTER: "public" | "flashbots-protect";
  FLASHBOTS_PROTECT_URL?: string;
  FLASHBOTS_STATUS_URL: string;
  PRIVATE_MIN_PRIORITY_FEE_WEI?: string;
  PRIVATE_RELAY_HORIZON_BLOCKS: string;
  PRIVATE_RECLAIM_MARGIN_BLOCKS: string;
  PRIVATE_SUBMIT_TIMEOUT_MS: string;
  PRIVATE_STATUS_TIMEOUT_MS: string;
  DATABASE_URL?: string;
}

/**
 * Where signed transactions are broadcast. A discriminated union so the private mode *carries* the
 * collaborators it cannot run without — the composition root reads them off it with no re-check, and
 * `public` simply has no relay-shaped fields.
 */
export type SubmitterSettings =
  | { mode: "public" }
  | {
      mode: "flashbots-protect";
      /** Protect RPC the signed transaction goes to. */
      rpcUrl: string;
      /** Status endpoint — the liveness source, and where each transaction's horizon is read from. */
      statusUrl: string;
      /** Floor for the priority fee; a transaction below it is not worth a builder's inclusion. */
      minPriorityFeeWei: bigint;
      /**
       * The relay's retry window in blocks, used when it does not report a transaction's own
       * deadline. Blocks rather than milliseconds because that is the unit the relay's own horizon
       * is in — a duration has to be guessed against it, and guessing low frees a live nonce.
       */
      relayHorizonBlocks: number;
      /** Reorg headroom past a transaction's horizon before its nonce may be reclaimed. */
      reclaimMarginBlocks: number;
      /**
       * Deadline for a submit. It is awaited under the nonce allocator's lock, so an unbounded one
       * does not merely lose a transaction — it stops every later send and resync in the process.
       */
      submitTimeoutMs: number;
      /** Deadline for a status probe. A probe that fails fences the nonce, so failing fast is safe. */
      statusTimeoutMs: number;
    };

/**
 * The variables that mean nothing unless the bot broadcasts privately, paired with their values.
 *
 * Named once because two builders reject them, for the same reason from opposite directions:
 * `buildSubmitterConfig` when the mode is `public`, and `buildExecutionConfig` when the mode is
 * MANUAL — where no submitter is built at all, so `SUBMITTER` itself is not what gives the mistake
 * away. Only the variables an operator sets by hand belong here: a defaulted field is present in
 * every deployment and says nothing about intent.
 */
const relayOnlyVars = (env: SubmitterEnv) =>
  [
    ["FLASHBOTS_PROTECT_URL", env.FLASHBOTS_PROTECT_URL],
    ["PRIVATE_MIN_PRIORITY_FEE_WEI", env.PRIVATE_MIN_PRIORITY_FEE_WEI],
  ] as const;

/**
 * Project the submission env into a service's boot plan, refusing every combination that would
 * broadcast differently from what the operator wrote.
 *
 * Guards **both** directions, like `buildArbitrageFundingParams`. The dangerous one is a relay
 * variable set without the mode: the bot would run and broadcast every liquidation into the public
 * mempool while the operator believed they had MEV protection. Silence there is the whole failure.
 *
 * The two private-mode requirements are not tuning knobs, they are the conditions under which
 * private submission is safe at all (`docs/design-026-private-relay-submission.md` §4.2, §4.3):
 *
 * - **A store.** Nonce safety currently rests on our own node being able to see our transactions,
 *   and a private transaction is invisible to it by design. The store is what holds the
 *   `nonce / hash / subject / horizon` state that replaces that visibility. Without it nothing
 *   fences the nonce — which is not a degraded mode, it is an unsafe one.
 * - **A priority-fee floor.** Flashbots drops transactions builders have no reason to include, so a
 *   negligible tip means MEV protection that silently never lands anything. No default: what is
 *   competitive is a market condition on the day, and a wrong guess here fails quietly.
 */
export function buildSubmitterConfig(env: SubmitterEnv): SubmitterSettings {
  const relayOnly = relayOnlyVars(env);

  if (env.SUBMITTER !== "flashbots-protect") {
    const stray = relayOnly.filter(([, v]) => v !== undefined).map(([name]) => name);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but SUBMITTER is "${env.SUBMITTER}", so every transaction would go to the PUBLIC mempool with no MEV protection. Set SUBMITTER=flashbots-protect, or remove the relay-only variables.`
      );
    }
    return { mode: "public" };
  }

  const missing = relayOnly.filter(([, v]) => v === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`SUBMITTER=flashbots-protect requires ${missing.join(", ")}`);
  }
  if (!env.DATABASE_URL) {
    throw new Error(
      "SUBMITTER=flashbots-protect requires DATABASE_URL — a privately-submitted transaction is invisible to our own node, so without persisted intents nothing fences the nonce against reuse"
    );
  }

  return {
    mode: "flashbots-protect",
    rpcUrl: env.FLASHBOTS_PROTECT_URL as string,
    statusUrl: env.FLASHBOTS_STATUS_URL,
    minPriorityFeeWei: BigInt(env.PRIVATE_MIN_PRIORITY_FEE_WEI as string),
    relayHorizonBlocks: Number.parseInt(env.PRIVATE_RELAY_HORIZON_BLOCKS, 10),
    reclaimMarginBlocks: Number.parseInt(env.PRIVATE_RECLAIM_MARGIN_BLOCKS, 10),
    submitTimeoutMs: Number.parseInt(env.PRIVATE_SUBMIT_TIMEOUT_MS, 10),
    statusTimeoutMs: Number.parseInt(env.PRIVATE_STATUS_TIMEOUT_MS, 10),
  };
}

/** Where secrets are resolved from. The key material itself never appears in `Config`. */
export function buildSecretsConfig(env: RuntimeEnv): SecretsConfig {
  return { source: env.SECRETS_PROVIDER, region: env.AWS_REGION };
}

/** Crash-safety persistence, present iff `DATABASE_URL` is set. */
export function buildPersistenceConfig(env: RuntimeEnv): PersistenceConfig | undefined {
  if (!env.DATABASE_URL) return undefined;
  return { connectionString: env.DATABASE_URL, schema: env.PERSISTENCE_SCHEMA };
}

/**
 * Project the execution-mode env into a service's boot plan, failing fast on a MANUAL setup that
 * cannot honor its own contract. MANUAL is keyless and durable, so it **requires** the broadcasting
 * address and a `StateStore`, and it **must not** carry a signing key — a MANUAL bot that resolved
 * one would break the property the mode exists for (no hot key to steal). AUTO is unchanged.
 *
 * `opts.signerKeyPresent` is whether the service's signing-key env var actually holds a value (the
 * service knows its own key-ref name, e.g. `LIQUIDATOR_PRIVATE_KEY`, so it computes this and passes
 * it in). It closes the gap the schema-field checks below cannot see: a MANUAL deployment that never
 * sets an explicit signer var but leaves the raw key in the process env — which a compromised MANUAL
 * process could still read and exfiltrate, defeating "no hot key to steal".
 */
export function buildExecutionConfig(
  env: ExecutionEnv,
  opts: { signerKeyPresent?: boolean } = {}
): ExecutionSettings {
  if (env.EXECUTION_MODE === "AUTO") {
    return { mode: "AUTO", submitter: buildSubmitterConfig(env) };
  }

  // Relay variables under MANUAL are the same category of mistake as signer variables below: the
  // process would boot, the operator would believe their transactions were protected, and in fact
  // this bot broadcasts nothing at all — their own wallet does, in public.
  //
  // Checked on the variables themselves and not only on `SUBMITTER`, because MANUAL never reaches
  // `buildSubmitterConfig`, which is what rejects a stray relay variable everywhere else. Left to
  // that check alone, a relay URL and a fee floor beside `EXECUTION_MODE=MANUAL` would boot in
  // silence — the one arrangement where nothing downstream ever touches them again.
  const strayRelay = [
    env.SUBMITTER === "flashbots-protect" ? "SUBMITTER=flashbots-protect" : undefined,
    ...relayOnlyVars(env)
      .filter(([, v]) => v !== undefined)
      .map(([name]) => name),
  ].filter((v): v is string => v !== undefined);
  if (strayRelay.length > 0) {
    throw new Error(
      `EXECUTION_MODE=MANUAL does not broadcast — an operator signs and sends with their own wallet, so ${strayRelay.join(", ")} protects nothing and this bot cannot enforce it. Unset ${strayRelay.length === 1 ? "it" : "them"}, or run AUTO.`
    );
  }

  if (!env.MANUAL_EXECUTOR_ADDRESS) {
    throw new Error(
      "EXECUTION_MODE=MANUAL requires MANUAL_EXECUTOR_ADDRESS (the EOA that will broadcast)"
    );
  }
  if (!env.DATABASE_URL) {
    throw new Error("EXECUTION_MODE=MANUAL requires DATABASE_URL — proposals must be persisted");
  }
  // Required, no default: the custody model changes how a proposal is broadcast AND how it is
  // confirmed, so a silent `eoa` default would mis-confirm a Safe deployment (its `execTransaction`
  // succeeds even when the inner call reverts). Make the operator declare it.
  if (!env.MANUAL_EXECUTOR_KIND) {
    throw new Error(
      "EXECUTION_MODE=MANUAL requires MANUAL_EXECUTOR_KIND (eoa | safe) — the operator's custody model"
    );
  }
  // We promised a MANUAL process holds no key: reject an explicitly configured signer, AND the raw
  // key material sitting in the env, rather than silently ignore either — so a mis-set deployment
  // stops at boot instead of running with a live key it did not expect to. (The composition root
  // also never calls `resolveSigner` in MANUAL, so the key is never loaded into a signer object;
  // this is the defense-in-depth that keeps it out of the process env entirely.)
  const signerVars = [
    env.SIGNER_SOURCE === "aws" && "SIGNER_SOURCE=aws",
    env.SIGNER_KEY_REF && "SIGNER_KEY_REF",
    env.KMS_KEY_ID && "KMS_KEY_ID",
    env.SIGNER_ADDRESS && "SIGNER_ADDRESS",
    opts.signerKeyPresent && "the signing-key env var",
  ].filter((v): v is string => Boolean(v));
  if (signerVars.length > 0) {
    throw new Error(
      `EXECUTION_MODE=MANUAL is keyless and must hold no signing key — unset ${signerVars.join(", ")}`
    );
  }

  return {
    mode: "MANUAL",
    manualExecutorAddress: env.MANUAL_EXECUTOR_ADDRESS as Hex40,
    executorKind: env.MANUAL_EXECUTOR_KIND,
    intentTtlMs: Number.parseInt(env.MANUAL_INTENT_TTL_MS, 10),
    intentStuckMs: Number.parseInt(env.MANUAL_INTENT_STUCK_MS, 10),
  };
}
