import { CONTROL_ROUTE_NAMES, createControlRoutes, resolveControlToken } from "./control";
import { createRiskGate } from "./gate";
import { startCodeHashGuard } from "./guard";
import type { CodeHashReader, RiskConfig, RiskGate } from "./types";

/**
 * Everything a bot process needs to stand up its one risk gate. Both composition roots did this
 * by hand and had to get the *ordering* right — the code-hash guard must run before the first tx.
 * Encoding the sequence once means a new service cannot get it subtly wrong.
 */
export interface RiskRuntimeConfig {
  /** Thresholds from `RISK_*` env (see `@repo/config`'s `buildRiskConfig`). */
  config: RiskConfig;
  /** How often to re-verify pinned bytecode after the boot check. */
  codeCheckIntervalMs: number;
  /** Secret *reference* for the kill-switch bearer token; unset ⇒ no control routes. */
  controlTokenRef?: string;
  /** Reads deployed bytecode — e.g. `(address) => readCodeHash(publicClient, address)`. */
  read: CodeHashReader;
  /** Resolves a secret reference to its value (the service's `@repo/secrets` provider). */
  getSecret: (ref: string) => Promise<string>;
  logger: { info(msg: string): void; warn(msg: string, ...rest: unknown[]): void };
}

export interface RiskRuntime {
  /** The process's single gate. Inject this into **every** engine. */
  gate: RiskGate;
  /** Kill-switch routes to hand to `startObservabilityServer`. Empty when unconfigured. */
  routes: ReturnType<typeof createControlRoutes>[];
  /** Banner lines for those routes. Empty when unconfigured. */
  routeNames: string[];
  /** Stop the periodic code-hash re-check. */
  stop(): void;
}

/**
 * Build the gate, verify pinned bytecode (halting on mismatch **before** any tx can go out), and
 * prepare the kill-switch routes. Callers must still pass `gate` to every engine and `routes` to
 * the observability server.
 */
export async function startRiskRuntime(config: RiskRuntimeConfig): Promise<RiskRuntime> {
  const { logger } = config;

  const gate = createRiskGate(config.config);
  if (config.config.startHalted) {
    logger.warn("RISK_START_HALTED=true — bot boots HALTED; POST /resume to start trading");
  }

  // Boot check runs here, before the caller wires up any engine or sends an approval.
  const stop = await startCodeHashGuard({
    risk: gate,
    read: config.read,
    intervalMs: config.codeCheckIntervalMs,
    onProbeError: (error) => logger.warn("Code-hash probe failed; will retry:", error),
  });

  const token = await resolveControlToken(config.controlTokenRef, config.getSecret);
  if (!token) {
    logger.info("Kill-switch endpoint: disabled (no RISK_CONTROL_TOKEN_REF)");
    return { gate, routes: [], routeNames: [], stop };
  }

  logger.info("Kill-switch endpoint: enabled (bearer token)");
  return {
    gate,
    routes: [createControlRoutes({ gate, token, onEvent: (m) => logger.warn(`[Control] ${m}`) })],
    routeNames: [...CONTROL_ROUTE_NAMES],
    stop,
  };
}
