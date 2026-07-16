import { type RpcCallObserver, instrumentedHttp, readCodeHash } from "@repo/chain";
import type { ExecutionSettings, NotifierSettings, RiskSettings } from "@repo/config";
import { type Executor, createAutoExecutorFromWallet, createManualExecutor } from "@repo/engine";
import { createNonceAllocator, createNonceLease, nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import { type Notifier, buildNotifier, riskEventSink } from "@repo/notifications";
import { type ObservabilityServerConfig, startObservabilityServer } from "@repo/observability";
import { type PersistenceConfig, type StateStore, createStateStore } from "@repo/persistence";
import { type RiskGate, startRiskRuntime } from "@repo/risk";
import { type SecretsConfig, type SecretsProvider, createSecrets } from "@repo/secrets";
import { type SignerConfig, resolveSigner } from "@repo/signer";
import {
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
}

/** The per-service knobs the shared boot can't derive: the RPC-call metric and the tagged logger. */
export interface BootDeps {
  recordRpcCall: RpcCallObserver;
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
 * before any tx can go out.
 */
export async function bootstrapService(config: BootConfig, deps: BootDeps): Promise<BootResult> {
  const { recordRpcCall, logger } = deps;

  // Secrets resolve the notifier webhook + risk control token in BOTH modes; only AUTO also resolves
  // a *signing key* through this provider (MANUAL is keyless and never touches one).
  const secrets = createSecrets(config.secrets);

  // Every viem call routes through `instrumentedHttp` so each outbound JSON-RPC method increments the
  // `eth_rpc_calls_total{method=...}` counter (providers bill per method, even under batching).
  const transport = instrumentedHttp(config.rpcUrl, recordRpcCall);

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

  const executor = await buildExecutor(config, {
    publicClient,
    chain,
    transport,
    store,
    notifier,
    secrets,
    logger,
  });

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
 * Build the process's single `Executor` from the execution mode. AUTO resolves the signing key and
 * builds the wallet + shared nonce authority (seeded from the chain before any send); MANUAL builds a
 * keyless proposer that holds no key, wallet, or nonce at all.
 */
async function buildExecutor(
  config: BootConfig,
  deps: {
    publicClient: PublicClient;
    chain: Chain;
    transport: Transport;
    store: StateStore | undefined;
    notifier: Notifier;
    secrets: SecretsProvider;
    logger: Logger;
  }
): Promise<Executor> {
  const { publicClient, chain, transport, store, notifier, secrets, logger } = deps;

  if (config.execution.mode === "MANUAL") {
    // Keyless: no signer, no WalletClient, no NonceAllocator anywhere in this process.
    if (!store) throw new Error("MANUAL execution requires a StateStore (DATABASE_URL)");
    const identity = { from: config.execution.manualExecutorAddress, chainId: chain.id };
    logger.info(`Execution mode: MANUAL — proposing from ${identity.from} (keyless)`);
    return createManualExecutor({ store, publicClient, notifier, identity, logger });
  }

  // AUTO — one signer, its wallet, and ONE nonce authority shared by every engine (so their
  // concurrent sends never collide).
  const signer = await resolveSigner(config.signer, (ref) => secrets.get(ref));
  logger.info(`Execution mode: AUTO — signer ${config.signer.source} (${signer.address})`);
  const walletClient = createWalletClient({ chain, transport, account: signer.account });
  const nonces = createNonceAllocator(createNonceLease(), signer.address);
  const executor = createAutoExecutorFromWallet({
    store,
    nonces,
    publicClient,
    walletClient,
    txReceiptTimeoutMs: config.txReceiptTimeoutMs,
    logger,
  });
  // Seed the shared lease from the chain once, before any send (boot approvals reserve nonces).
  await nonces.resync(() => nextNonce(publicClient, signer.address));
  return executor;
}
