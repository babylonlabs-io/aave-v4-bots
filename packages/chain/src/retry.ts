import { createLogger } from "@repo/logger";

const logger = createLogger();

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /**
   * Per-attempt request timeout for `fetchWithRetry`, in ms. Retry only reacts to a request that
   * *fails*: a peer that accepts the connection and then never answers produces no error at all,
   * so a poll loop awaiting it simply stops — no retry, no metric, no log, and a bot that looks
   * alive while doing nothing. Bounding each attempt turns that silence into a normal retryable
   * failure. Optional only so existing full `RetryConfig` values keep type-checking; the default
   * below applies when unset.
   */
  timeoutMs?: number;
}

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  timeoutMs: 10000,
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.initialDelayMs * config.backoffMultiplier ** attempt;
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Execute a function with retry and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryConfig> = {},
  context?: string
): Promise<T> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isLastAttempt = attempt === config.maxAttempts - 1;
      if (isLastAttempt) {
        break;
      }

      const delay = calculateDelay(attempt, config);
      const contextStr = context ? `[${context}] ` : "";
      logger.warn(
        `${contextStr}Attempt ${attempt + 1}/${config.maxAttempts} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Fetch with retry and exponential backoff
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryConfig?: Partial<RetryConfig>
): Promise<Response> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  return withRetry(
    async () => {
      // Built per attempt, not hoisted: an AbortSignal is single-use, so one shared signal would
      // leave every retry after the first starting out already aborted. A caller-supplied signal
      // wins — it owns the request's lifetime and may be cancelling for its own reasons.
      const response = await fetch(url, {
        ...options,
        signal: options?.signal ?? AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok && response.status >= 500) {
        // Retry on 5xx errors
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    },
    config,
    `fetch ${url}`
  );
}
