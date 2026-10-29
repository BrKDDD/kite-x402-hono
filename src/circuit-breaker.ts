/**
 * Circuit breaker pattern implementation for upstream and facilitator RPC resilience.
 * Protects downstream services from cascading failures and connection starvation
 * by failing fast during consecutive outages and gracefully probing recovery.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to stay OPEN before attempting recovery in HALF_OPEN. Default: 10,000ms */
  recoveryTimeoutMs?: number;
  /** Consecutive successes in HALF_OPEN needed to close the circuit. Default: 2 */
  halfOpenSuccessThreshold?: number;
  /** Optional predicate to determine if an error should trigger circuit failure. */
  isFailure?: (error: unknown) => boolean;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  rejectedCount: number;
  totalTrips: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

export class CircuitBreakerOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Circuit breaker is OPEN. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "CircuitBreakerOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private rejectedCount = 0;
  private totalTrips = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private stateChangeTime: number = Date.now();

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 10_000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
    this.isFailure = options.isFailure ?? (() => true);
  }

  getState(): CircuitState {
    if (this.state === "OPEN") {
      const now = Date.now();
      if (now - this.stateChangeTime >= this.recoveryTimeoutMs) {
        this.transitionTo("HALF_OPEN");
      }
    }
    return this.state;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.stateChangeTime = Date.now();

    if (newState === "OPEN") {
      this.totalTrips++;
      this.consecutiveSuccesses = 0;
    } else if (newState === "HALF_OPEN") {
      this.consecutiveSuccesses = 0;
    } else if (newState === "CLOSED") {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "OPEN") {
      this.rejectedCount++;
      const remainingMs = Math.max(
        0,
        this.recoveryTimeoutMs - (Date.now() - this.stateChangeTime),
      );
      throw new CircuitBreakerOpenError(remainingMs);
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) {
        this.onFailure();
      }
      throw err;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();
    this.consecutiveFailures = 0;

    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo("CLOSED");
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;

    if (this.state === "CLOSED") {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo("OPEN");
      }
    } else if (this.state === "HALF_OPEN") {
      this.transitionTo("OPEN");
    }
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      rejectedCount: this.rejectedCount,
      totalTrips: this.totalTrips,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.successes = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.rejectedCount = 0;
    this.stateChangeTime = Date.now();
  }
}
