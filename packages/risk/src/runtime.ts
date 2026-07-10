import { createControlRoutes, resolveControlToken } from "./control";
import { startControlServer } from "./controlServer";
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
  /** Secret *reference* for the kill-switch bearer token; unset ⇒ no kill-switch server. */
  controlTokenRef?: string;
  /** Where the kill-switch server listens. Its own socket; loopback unless told otherwise. */
  controlPort: number;
  controlHost: string;
  /** Reads deployed bytecode — e.g. `(address) => readCodeHash(publicClient, address)`. */
  read: CodeHashReader;
  /** Resolves a secret reference to its value (the service's `@repo/secrets` provider). */
  getSecret: (ref: string) => Promise<string>;
  logger: { info(msg: string): void; warn(msg: string, ...rest: unknown[]): void };
}

export interface RiskRuntime {
  /** The process's single gate. Inject this into **every** engine. */
  gate: RiskGate;
  /** Stop the periodic code-hash re-check and close the kill-switch server. */
  stop(): void;
}

/**
 * Build the gate, verify pinned bytecode (halting on mismatch **before** any tx can go out), and
 * — when a control token is configured — start the kill-switch server on its own socket. The
 * caller's only remaining job is to pass `gate` to every engine it builds.
 */
export async function startRiskRuntime(config: RiskRuntimeConfig): Promise<RiskRuntime> {
  const { logger } = config;

  const gate = createRiskGate(config.config);
  if (config.config.startHalted) {
    logger.warn("RISK_START_HALTED=true — bot boots HALTED; POST /resume to start trading");
  }

  // Boot check runs here, before the caller wires up any engine or sends an approval. Skipped
  // entirely when nothing is pinned — otherwise an unconfigured deployment carries a timer that
  // wakes every 5 minutes to verify nothing.
  const stopCodeHashGuard = config.config.expectedCodeHashes
    ? await startCodeHashGuard({
        risk: gate,
        read: config.read,
        intervalMs: config.codeCheckIntervalMs,
        onProbeError: (error) => logger.warn("Code-hash probe failed; will retry:", error),
      })
    : () => {};

  const token = await resolveControlToken(config.controlTokenRef, config.getSecret);
  if (!token) {
    logger.info("Kill-switch endpoint: disabled (no RISK_CONTROL_TOKEN_REF)");
    // A tripped breaker or a boot-probe halt is only clearable by restarting the process. That is
    // a real recovery path, but the operator should know it is the only one they have.
    const canAutoHalt =
      config.config.maxConsecutiveFailures !== undefined ||
      config.config.expectedCodeHashes !== undefined;
    if (canAutoHalt) {
      logger.warn(
        "Auto-halt guards are enabled but no kill-switch endpoint is mounted — " +
          "recovering from a HALTED gate will require restarting the process"
      );
    }
    return { gate, stop: stopCodeHashGuard };
  }

  const server = startControlServer({
    port: config.controlPort,
    host: config.controlHost,
    handle: createControlRoutes({ gate, token, onEvent: (m) => logger.warn(`[Control] ${m}`) }),
    logger,
  });

  return {
    gate,
    stop() {
      stopCodeHashGuard();
      server.close();
    },
  };
}
