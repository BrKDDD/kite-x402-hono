/**
 * Resilient retry policy with exponential backoff and jitter algorithms.
 * Prevents thundering-herd issues during transient upstream outages and
 * facilitator network blips in high-throughput x402 payment architectures.
 */

export interface RetryOptions {
  /** Maximum retry attempts. Default: 3 */
  maxAttempts?: number;
  /** Initial delay in milliseconds before the first retry. Default: 200ms */
  initialDelayMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 5,000ms */
  maxDelayMs?: number;
  /** Multiplier for each subsequent backoff iteration. Default: 2.0 */
  backoffFactor?: number;
  /** Whether to apply full jitter to randomize backoff intervals. Default: true */
  jitter?: boolean;
  /** Optional custom predicate to determine if an error is retryable. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Optional callback fired before each retry sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface RetryStats {
  attempts: number;
  retriesExhausted: boolean;
  totalDelayMs: number;
}

/**
 * Standard HTTP transient status codes that are safely retryable for idempotent calls.
 */
export const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Default error predicate checking for transient network errors and common gateway statuses.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // Check fetch Response / status
  if (typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    return TRANSIENT_STATUS_CODES.has(status);
  }

  // Check network error codes
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("connection reset") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("timeout")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates exponential backoff delay with full jitter.
 */
export function computeBackoffDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffFactor: number,
  jitter: boolean,
): number {
  const exponential = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
  const capped = Math.min(maxDelayMs, exponential);

  if (!jitter) {
    return capped;
  }

  // Full Jitter: Uniform random between 0 and capped
  return Math.floor(Math.random() * (capped + 1));
}

/**
 * Executes an asynchronous task with exponential backoff and jitter.
 */
export async function executeWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const backoffFactor = options.backoffFactor ?? 2.0;
  const jitter = options.jitter ?? true;
  const isRetryable = options.isRetryable ?? isTransientError;

  let attempt = 1;

  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error, attempt)) {
        throw error;
      }

      const delayMs = computeBackoffDelay(
        attempt,
        initialDelayMs,
        maxDelayMs,
        backoffFactor,
        jitter,
      );

      if (options.onRetry) {
        options.onRetry(error, attempt, delayMs);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}
