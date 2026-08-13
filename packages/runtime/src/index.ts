import { safeAbi } from "@repo/abis";
import { type RetryConfig, instrumentedHttp, readCodeHash } from "@repo/chain";
import type {
  ExecutionSettings,
  NotifierSettings,
  RiskSettings,
  SubmitterSettings,
} from "@repo/config";
import {
  type Executor,
  type Submission,
  createAutoExecutorFromWallet,
  createChainReader,
  createManualExecutor,
  createRelayAwareReader,
  createRelayHorizon,
} from "@repo/engine";
import {
  PreBroadcastError,
  createFlashbotsProtectSubmitter,
  createNonceAllocator,
  createNonceLease,
} from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type Notifier, buildNotifier, riskEventSink } from "@repo/notifications";
import {
  type MetricsRegistry,
  type ObservabilityServerConfig,
  startObservabilityServer,
} from "@repo/observability";
import { type PersistenceConfig, type StateStore, createStateStore } from "@repo/persistence";
import { type RiskGate, startRiskRuntime } from "@repo/risk";
import { type SecretsConfig, type SecretsProvider, createSecrets } from "@repo/secrets";
import { type SignerConfig, resolveSigner } from "@repo/signer";
import {
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  createPublicClient,
  createWalletClient,
} from "viem";

// The shared runtime for the bot services — the process lifecycle both the liquidator and the
// arbitrageur run identically, so it lives here once rather than forking across two `index.ts`
// files (the real risk with a security-critical boot sequence: a fix to one, missed on the other):
//
//   `bootstrapService` — one signer or one keyless operator, one nonce authority, one risk gate, one
//     store, one notifier. Returns the pieces a service builds its engine(s) on.
//   `startRuntime`      — `bootstrapService` + the metrics/health server + graceful shutdown. The
//     poll loops stay in each service (they differ: the arbitrageur runs two on different intervals).
//
// Each service supplies its own RPC-call metric, tagged logger, and health-probe config, and builds
// its engine(s) on the result.

/**
 * The config surface the boot sequence reads — the subset both services' `Config`s already carry
 * (each extends `RiskSettings` and adds these). An engine's own domain params (addresses, poll
 * intervals) are NOT here; those stay in the service, next to the engine that consumes them.
 */
export interface BootConfig extends RiskSettings {
  rpcUrl: string;
  secrets: SecretsConfig;
  signer: SignerConfig;
  /** Crash-safety persistence; present iff `DATABASE_URL` is set. MANUAL requires it. */
  persistence?: PersistenceConfig;
  notifier: NotifierSettings;
  execution: ExecutionSettings;
  /** Receipt-wait budget for AUTO approvals (the executor's only use of it). */
  txReceiptTimeoutMs: number;
  /**
   * The process's retry policy. Applied here to the RPC transport, so it governs **every** chain
   * read the process makes.
   *
   * One policy, applied once at the transport rather than at call sites: a read cannot then be
   * resilient in one engine and not another. Unset ⇒ viem's own defaults.
   */
  retryConfig?: RetryConfig;
}

/** The per-service knobs the shared boot can't derive: the metric recorders and the tagged logger. */
export interface BootDeps {
  /**
   * The process-level recorders this boot wires up: the RPC transport counter, and — in private
   * submission — how the relay answered each broadcast and what it later said about it.
   *
   * One object rather than loose callbacks, matching how engines and the indexer take their metrics.
   * All three are required: an operator's only view of "the relay is refusing us" or "our
   * transactions are unviable" is these counters, and a service that quietly passed none of them
   * would look healthy while landing nothing.
   */
  metrics: Pick<MetricsRegistry, "recordRpcCall" | "recordSubmit" | "recordRelayStatus">;
  logger: Logger;
}

/** What the shared boot hands back — the pieces a service needs to build its engine(s) + shut down. */
export interface BootResult {
  publicClient: PublicClient;
  /** Present iff persistence is configured. `startRuntime` closes it on shutdown; a standalone
   *  `bootstrapService` caller owns that. */
  store: StateStore | undefined;
  /** The one risk gate for the process, injected into every engine. */
  risk: RiskGate;
  /** The one execution collaborator for the process, injected into every engine. */
  executor: Executor;
}

/**
 * Bind the submission choice to a `Submitter`. MANUAL never reaches this — an operator broadcasts
 * with their own wallet, so submission policy is theirs.
 *
 * The mode is logged because it is otherwise invisible: a bot broadcasting publicly when the
 * operator believed it was private looks identical from the outside, right up until a liquidation
 * is front-run.
 */
function buildSubmission(
  settings: SubmitterSettings,
  publicClient: PublicClient,
  logger: Logger,
  metrics: Pick<MetricsRegistry, "recordSubmit" | "recordRelayStatus">
): Submission | undefined {
  // `undefined` is the public mempool, not an absence of configuration: it is already what
  // `createTxSender` does with no override, and what the nonce fence assumes. Returning a
  // "public submitter" here would be a second way to spell the default.
  if (settings.mode !== "flashbots-protect") {
    logger.info("Submission: public mempool");
    return undefined;
  }
  logger.info(`Submission: Flashbots Protect (${settings.rpcUrl})`);
  const relay = createFlashbotsProtectSubmitter({
    rpcUrl: settings.rpcUrl,
    statusUrl: settings.statusUrl,
    onResult: metrics.recordSubmit,
  });
  const node = createChainReader(publicClient);
  return {
    submitter: relay,
    reader: createRelayAwareReader(node, relay, logger, metrics.recordRelayStatus),
    reclaimMarginBlocks: settings.reclaimMarginBlocks,
    horizon: createRelayHorizon(node, relay, settings.relayHorizonBlocks),
  };
}

/** A minimal viem `Chain` for a self-hosted RPC whose id we auto-detect. */
function buildLocalChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: "Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/**
 * Run the shared boot sequence and return the pieces a service builds its engine(s) on. Ordering is
 * load-bearing: the executor is built last (its AUTO branch seeds the nonce lease from the chain, so
 * a boot-time approval can reserve a nonce), and the risk gate verifies the pinned target bytecode
 * before the engines are built.
 *
 * Verifying first is not the same as being obeyed: the gate's state is read when a slot is opened,
 * which is inside the poll cycle, so nothing here is protected by ordering alone. What protects a
 * transaction is `assertCanBroadcast` below — every send goes through it, including the approvals
 * inventory funding needs, which is why those moved out of boot-time setup and into the cycle.
 */
export async function bootstrapService(config: BootConfig, deps: BootDeps): Promise<BootResult> {
  const { metrics, logger } = deps;

  // Secrets resolve the notifier webhook + risk control token in BOTH modes; only AUTO also resolves
  // a *signing key* through this provider (MANUAL is keyless and never touches one).
  const secrets = createSecrets(config.secrets);

  // Every viem call routes through `instrumentedHttp`, which both applies the retry policy and
  // increments `eth_rpc_calls_total{method=...}` per attempt (providers bill per method per
  // attempt, even under batching).
  const transport = instrumentedHttp(config.rpcUrl, metrics.recordRpcCall, {
    retry: config.retryConfig,
  });

  // Auto-detect the chain id from the RPC, then build the real chain + client on it.
  const chainId = await createPublicClient({ transport }).getChainId();
  logger.info(`Chain ID: ${chainId}`);
  const chain = buildLocalChain(chainId, config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  // Crash-safety StateStore (Postgres) when configured; otherwise undefined (in-memory, no
  // idempotency). MANUAL requires one — `buildExecutionConfig` already rejects MANUAL without it.
  const store = config.persistence ? createStateStore(config.persistence) : undefined;
  logger.info(`Persistence: ${store ? "postgres" : "disabled"}`);

  // Outbound alerts. The Slack webhook is a credential, resolved from its secret ref like the signing
  // key; `none` (default) logs only. Delivery is best-effort, so a dropped alert never breaks a poll
  // cycle. In MANUAL it also carries the operator's sign-me alerts.
  const notifier = await buildNotifier(config.notifier, logger, (ref) => secrets.get(ref));

  // Exactly ONE risk gate per process, injected into every engine — a kill-switch or tripped breaker
  // must halt everything this process drives. Also verifies the pinned target bytecode before any tx
  // goes out, and — when a control token is configured — starts the authenticated kill-switch server
  // on its own loopback socket. Its state changes route to the notifier.
  const { gate: risk } = await startRiskRuntime({
    config: config.risk,
    codeCheckIntervalMs: config.codeCheckIntervalMs,
    controlTokenRef: config.controlTokenRef,
    controlPort: config.controlPort,
    controlHost: config.controlHost,
    read: (address) => readCodeHash(publicClient, address),
    getSecret: (ref) => secrets.get(ref),
    onEvent: riskEventSink(notifier),
    logger,
  });

  const executor = await buildExecutor(
    config,
    // The gate's last word, as a bare callback: `@repo/execution` signs and sends and has no reason
    // to know what a risk gate is. `openSlot` reads this state once per cycle, and a halt can land
    // after it — the kill switch, or a periodic code-hash check finding a target's bytecode changed.
    // `PreBroadcastError` is the classification the engines already read as "nothing reached the
    // chain", so a refusal here settles the slot `abandoned` and leaves the breaker alone.
    (action) => {
      if (risk.state() === "HALTED") {
        throw new PreBroadcastError(
          `risk gate is HALTED — refusing to broadcast ${action} (${risk.haltReason()})`
        );
      }
    },
    {
      publicClient,
      chain,
      transport,
      store,
      notifier,
      secrets,
      logger,
      metrics,
    }
  );

  return { publicClient, store, risk, executor };
}

/** `BootDeps` plus the health-probe config — everything `startRuntime` needs beyond the config. */
export interface RuntimeDeps extends BootDeps {
  /** Metrics + health server config; its `publicClient` is supplied from the boot result. */
  observability: Omit<ObservabilityServerConfig, "publicClient">;
}

/**
 * The full poll-mode lifecycle: `bootstrapService`, then start the metrics/health server (wired to the
 * boot's `publicClient`) and register graceful shutdown (SIGINT/SIGTERM close the DB pool). Returns the
 * same `BootResult` so the service can build its engine(s) and poll loops on top. Use `bootstrapService`
 * directly for a command that needs the executor but not the server (neither service does today).
 */
export async function startRuntime(config: BootConfig, deps: RuntimeDeps): Promise<BootResult> {
  const boot = await bootstrapService(config, deps);
  startObservabilityServer({ ...deps.observability, publicClient: boot.publicClient });
  registerGracefulShutdown(boot.store, deps.logger);
  return boot;
}

/** Close the DB pool on SIGINT/SIGTERM, then exit — the store is the only resource needing release. */
function registerGracefulShutdown(store: StateStore | undefined, logger: Logger): void {
  const shutdown = async () => {
    logger.info("Shutting down...");
    await store?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Fail boot unless the MANUAL executor address matches the declared custody model. `eoa` must be a
 * plain account (no code); `safe` must be a contract that answers the Safe interface (`getThreshold` +
 * `nonce`) — "has code" alone is too weak, since any contract has code. A mismatch is a
 * misconfiguration that would otherwise surface later as mis-confirmed intents, so it stops here.
 */
async function assertCustody(
  publicClient: PublicClient,
  address: Address,
  kind: "eoa" | "safe",
  logger: Logger
): Promise<void> {
  const code = await publicClient.getCode({ address });
  const hasCode = code !== undefined && code !== "0x";
  if (kind === "eoa") {
    if (hasCode) {
      throw new Error(
        `MANUAL_EXECUTOR_KIND=eoa but ${address} has contract code — set MANUAL_EXECUTOR_KIND=safe or fix the address`
      );
    }
    return;
  }
  if (!hasCode) {
    throw new Error(`MANUAL_EXECUTOR_KIND=safe but ${address} has no contract code`);
  }
  try {
    const threshold = await publicClient.readContract({
      address,
      abi: safeAbi,
      functionName: "getThreshold",
    });
    await publicClient.readContract({ address, abi: safeAbi, functionName: "nonce" });
    logger.info(`MANUAL executor ${address} verified as a Safe (threshold ${threshold})`);
  } catch (error) {
    throw new Error(
      `MANUAL_EXECUTOR_KIND=safe but ${address} does not answer the Safe interface (getThreshold/nonce): ${error}`
    );
  }
}

/**
 * Build the process's single `Executor` from the execution mode. AUTO resolves the signing key and
 * builds the wallet + shared nonce authority (seeded from the chain before any send); MANUAL builds a
 * keyless proposer that holds no key, wallet, or nonce at all.
 */
async function buildExecutor(
  config: BootConfig,
  /** See the call site: the gate's verdict, as a callback this layer can hold without a risk dep. */
  assertCanBroadcast: (action: string) => void,
  deps: {
    publicClient: PublicClient;
    chain: Chain;
    transport: Transport;
    store: StateStore | undefined;
    notifier: Notifier;
    secrets: SecretsProvider;
    logger: Logger;
    metrics: BootDeps["metrics"];
  }
): Promise<Executor> {
  const { publicClient, chain, transport, store, notifier, secrets, logger } = deps;

  if (config.execution.mode === "MANUAL") {
    // Keyless: no signer, no WalletClient, no NonceAllocator anywhere in this process.
    if (!store) throw new Error("MANUAL execution requires a StateStore (DATABASE_URL)");
    const identity = { from: config.execution.manualExecutorAddress, chainId: chain.id };
    await store.bindExecutionIdentity({ chainId: identity.chainId, address: identity.from });
    // Confirm the on-chain account matches the operator's declared custody, so a `safe` deployment
    // pointed at a bare EOA (or vice-versa) stops at boot instead of mis-confirming intents later.
    await assertCustody(publicClient, identity.from, config.execution.executorKind, logger);
    logger.info(
      `Execution mode: MANUAL (${config.execution.executorKind}) — proposing from ${identity.from} (keyless)`
    );
    return createManualExecutor({
      store,
      publicClient,
      notifier,
      identity,
      logger,
      intentTtlMs: config.execution.intentTtlMs,
      intentStuckMs: config.execution.intentStuckMs,
    });
  }

  // AUTO — one signer, its wallet, and ONE nonce authority shared by every engine (so their
  // concurrent sends never collide).
  const signer = await resolveSigner(config.signer, (ref) => secrets.get(ref));
  logger.info(`Execution mode: AUTO — signer ${config.signer.source} (${signer.account.address})`);
  // Before anything reads or writes the store. `resyncNonces` below already reasons over every
  // in-flight intent as one nonce sequence, so a schema shared with another signer would fence on
  // transactions that are not ours — this is where that stops being possible.
  await store?.bindExecutionIdentity({ chainId: chain.id, address: signer.account.address });

  const walletClient = createWalletClient({ chain, transport, account: signer.account });
  const nonces = createNonceAllocator(createNonceLease(), signer.account.address);
  const submission = buildSubmission(
    config.execution.submitter,
    publicClient,
    logger,
    deps.metrics
  );
  const executor = createAutoExecutorFromWallet({
    store,
    nonces,
    publicClient,
    walletClient,
    submission,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    assertCanBroadcast,
    logger,
  });
  // Seed the shared lease from the chain once, before any send (the boot `ensureApproval` reserves
  // nonces before the poll loop's first resync). Go through the executor's fenced resync, not a raw
  // `nextNonce` read: it applies the same `liveNonceFloor` fence the poll loop does, so a prior
  // crashed process's in-flight tx that the node's `pending` count under-reports can't be collided
  // with by the very first approval.
  await executor.resyncNonces();
  return executor;
}
