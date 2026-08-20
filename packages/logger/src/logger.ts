export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal structured logging surface. Kept intentionally small so it can be
 * injected as a port (e.g. into `@repo/engine`) and its backend swapped later
 * (JSON, a transport) in one place instead of touching every call site.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LoggerOptions {
  /** Prepended to every message — e.g. "[Bot] " to tag a service's lines. */
  prefix?: string;
  /**
   * Minimum level to emit; lower-severity messages are dropped. Defaults to the
   * `LOG_LEVEL` env var, or "info" when that is unset/invalid.
   */
  level?: LogLevel;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "info";
}

/**
 * Create a console-backed logger. `info` maps to `console.log`, the rest to the
 * matching `console` method, each prefixed and gated by the resolved level.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const prefix = options.prefix ?? "";
  const threshold = LEVELS[resolveLevel(options.level)];
  const enabled = (level: LogLevel): boolean => LEVELS[level] >= threshold;

  return {
    debug(message, ...args) {
      if (enabled("debug")) console.debug(`${prefix}${message}`, ...args);
    },
    info(message, ...args) {
      if (enabled("info")) console.log(`${prefix}${message}`, ...args);
    },
    warn(message, ...args) {
      if (enabled("warn")) console.warn(`${prefix}${message}`, ...args);
    },
    error(message, ...args) {
      if (enabled("error")) console.error(`${prefix}${message}`, ...args);
    },
  };
}
